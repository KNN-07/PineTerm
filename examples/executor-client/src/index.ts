import { randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import type { DriverReply, DriverRequest, ExecutorClaim, ExecutorControl, ExecutorLease, ExternalFill, IntentState, LiveIntent, SubmitExecutorReport } from '@pineterm/contracts';
import { riskDecimal, riskPositive } from '@pineterm/domain';
import { FinanceClient } from '../../api-client/src/index.js';
import { executable, runDriver } from './driver.js';

export interface ExecutorClientOptions {
  api: FinanceClient; executorId: string; driver: string; statePath: string; driverArgs?: string[]; timeoutMs?: number;
  requireSandbox?: boolean;
  onEvent?: (event: { type: 'claimed' | 'reported' | 'unresolved' | 'driver_failed' | 'report_pending'; intentId: string; state?: IntentState }) => void;
}
export interface ExecutorCycleResult { intentId: string | null; state: IntentState | null; unresolved: boolean }
interface StoredOrder { intent_id: string; lease_json: string; phase: 'recovered' | 'attempted' | 'observed' | 'terminal'; last_reply: string | null }
interface PendingReport { report_id: string; intent_id: string; body_json: string }
const terminal: Record<string, true> = { filled: true, rejected: true, cancelled: true, expired: true };
function fillFingerprint(fill: ExternalFill): string {
  return JSON.stringify({ externalFillId: fill.externalFillId, quantity: fill.quantity, price: fill.price, fee: fill.fee, currency: fill.currency, time: fill.time });
}

/** Durable, single-owner client. A process crash makes every recovered row reconciliation-only,
 * including a claim persisted before submission. There is intentionally no submit retry path. */
export class ExecutorClient {
  private readonly db: Database.Database;
  private readonly driver: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly stop = new AbortController();
  private readonly lockPath: string;
  private active: Promise<ExecutorCycleResult> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  private serverTime: number | null = null;
  private monotonicAt = 0;
  constructor(private readonly options: ExecutorClientOptions) {
    this.driver = executable(options.driver); // Refuse missing drivers before touching the API/state.
    if (!/^[0-9a-f-]{36}$/i.test(options.executorId)) throw new Error('A registered executor UUID is required.');
    this.args = options.driverArgs ?? [];
    if (!Array.isArray(this.args) || this.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Driver arguments must be a string array.');
    this.timeoutMs = options.timeoutMs ?? 10000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000) throw new Error('Driver timeout must be 1–30000 ms.');
    if (!isAbsolute(options.statePath)) throw new Error('Executor state must use an absolute SQLite path in a private directory.');
    const directory = dirname(options.statePath);
    for (let ancestor = directory; ; ancestor = dirname(ancestor)) {
      try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error('Executor state paths cannot traverse directory symlinks.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (ancestor === dirname(ancestor)) break;
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const folder = lstatSync(directory);
    if (!folder.isDirectory() || folder.isSymbolicLink() || (folder.mode & 0o077) !== 0 || folder.uid !== process.getuid?.()) throw new Error('Executor state directory must be owned by this user and private (0700).');
    this.lockPath = options.statePath + '.lock';
    try {
      const existing = lstatSync(this.lockPath);
      if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0 || existing.uid !== process.getuid?.()) throw new Error('Unsafe executor state lock.');
      const pid = Number(readFileSync(this.lockPath, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Unsafe executor state lock.');
      try { process.kill(pid, 0); throw new Error('Executor state is already owned by a running process.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      unlinkSync(this.lockPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const lock = openSync(this.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(lock, String(process.pid)); closeSync(lock);
    let database: Database.Database | undefined;
    try {
      try { const file = openSync(options.statePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const file = lstatSync(options.statePath);
      if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 || file.uid !== process.getuid?.()) throw new Error('Executor SQLite state must be owned by this user and private (0600).');
      database = new Database(options.statePath); this.db = database;
      this.db.pragma('journal_mode = DELETE'); this.db.pragma('synchronous = FULL'); this.db.pragma('foreign_keys = ON');
      this.db.exec(`CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), executor_id TEXT NOT NULL, origin TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS orders (intent_id TEXT PRIMARY KEY, lease_json TEXT NOT NULL, phase TEXT NOT NULL, last_reply TEXT);
        CREATE TABLE IF NOT EXISTS reports (report_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES orders(intent_id), body_json TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS fills (intent_id TEXT NOT NULL REFERENCES orders(intent_id), fill_id TEXT NOT NULL, fill_json TEXT NOT NULL, PRIMARY KEY(intent_id,fill_id));`);
      const identity = this.db.prepare('SELECT executor_id,origin FROM identity').get() as { executor_id: string; origin: string } | undefined;
      if (identity && (identity.executor_id !== options.executorId || identity.origin !== options.api.url)) throw new Error('Executor state belongs to a different executor or finance API origin.');
      if (!identity) this.db.prepare('INSERT INTO identity VALUES(1,?,?)').run(options.executorId, options.api.url);
    } catch (error) { database?.close(); unlinkSync(this.lockPath); throw error; }
  }
  cycle(): Promise<ExecutorCycleResult> {
    if (this.closed) return Promise.reject(new Error('Executor client is closed.'));
    if (this.active) return this.active;
    this.active = this.runCycle().finally(() => { this.active = null; });
    return this.active;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.stop.abort();
    this.closing = (async () => {
      try { await this.active; } catch { /* The durable state remains reconciliation-only. */ }
      this.db.close(); unlinkSync(this.lockPath);
    })();
    return this.closing;
  }
  private now(): number {
    if (this.serverTime === null) throw new Error('Server time has not been observed.');
    return Math.ceil(this.serverTime + performance.now() - this.monotonicAt);
  }
  private async control(): Promise<ExecutorControl> {
    const started = performance.now();
    const response = await this.options.api.request<ExecutorControl>('/executors/' + this.options.executorId + '/control', { signal: this.stop.signal });
    this.anchor(response.serverTime, started);
    return response;
  }
  private anchor(serverTime: number, requestStarted: number) {
    if (!Number.isSafeInteger(serverTime) || serverTime < 0) throw new Error('Invalid executor server clock.');
    // Include round-trip elapsed time conservatively; wall-clock changes cannot extend leases.
    const elapsed = performance.now();
    const previous = this.serverTime === null ? 0 : this.serverTime + elapsed - this.monotonicAt;
    this.serverTime = Math.max(previous, serverTime + elapsed - requestStarted); this.monotonicAt = elapsed;
  }
  private emit(type: Parameters<NonNullable<ExecutorClientOptions['onEvent']>>[0]['type'], intentId: string, state?: IntentState) {
    try { this.options.onEvent?.({ type, intentId, ...(state ? { state } : {}) }); } catch { /* Observers cannot alter submission state. */ }
  }
  private storeLease(lease: ExecutorLease, phase: StoredOrder['phase']) {
    if (lease.clientOrderId !== lease.intent.id || lease.intent.executorId !== this.options.executorId || lease.intent.market.provider === 'csv') throw new Error('Invalid executor lease identity.');
    this.db.prepare('INSERT INTO orders(intent_id,lease_json,phase) VALUES(?,?,?) ON CONFLICT(intent_id) DO UPDATE SET lease_json=excluded.lease_json').run(lease.intent.id, JSON.stringify(lease), phase);
    for (const report of lease.intent.reports) for (const fill of report.fills) {
      const previous = this.db.prepare('SELECT fill_json FROM fills WHERE intent_id=? AND fill_id=?').get(lease.intent.id, fill.externalFillId) as { fill_json: string } | undefined;
      if (previous && previous.fill_json !== fillFingerprint(fill)) throw new Error('Conflicting external fill identity.');
      this.db.prepare('INSERT OR IGNORE INTO fills VALUES(?,?,?)').run(lease.intent.id, fill.externalFillId, fillFingerprint(fill));
    }
  }
  private request(lease: ExecutorLease, command: DriverRequest['command'], stage: DriverRequest['stage']): DriverRequest {
    const { reports: _reports, ...intent } = lease.intent;
    return { protocol: 1, command, stage, clientOrderId: lease.clientOrderId, intent, quoteCurrency: lease.quoteCurrency, quantityStep: lease.quantityStep, tickSize: lease.tickSize, minExecutionPrice: lease.minExecutionPrice, maxExecutionPrice: lease.maxExecutionPrice, now: this.now(), ...(this.options.requireSandbox ? { requireSandbox: true } : {}) };
  }
  private async driverCall(lease: ExecutorLease, command: DriverRequest['command'], stage: DriverRequest['stage']): Promise<DriverReply> {
    const reply = await runDriver(this.driver, this.args, this.request(lease, command, stage), this.timeoutMs, this.stop.signal);
    if (this.options.requireSandbox && (!['sandbox', 'testnet'].includes(reply.environment ?? '') || !reply.venue)) throw new Error('The operator driver did not attest a sandbox/testnet venue.');
    return reply;
  }
  private queue(lease: ExecutorLease, reply: DriverReply) {
    if (reply.status === 'not_submitted') throw new Error('Absence is not an execution report.');
    const status = reply.status;
    const stored = this.db.prepare('SELECT last_reply FROM orders WHERE intent_id=?').get(lease.intent.id) as { last_reply: string | null };
    // Strip untrusted driver reason/quote: neither belongs in reports or logs.
    const signature = JSON.stringify({ status: reply.status, externalOrderId: reply.externalOrderId ?? null, fills: reply.fills.map(fillFingerprint) });
    if (stored.last_reply === signature) return;
    this.db.transaction(() => {
      const newFills: ExternalFill[] = [];
      let quantity = riskDecimal('0');
      const known = this.db.prepare('SELECT fill_id,fill_json FROM fills WHERE intent_id=?').all(lease.intent.id) as Array<{ fill_id: string; fill_json: string }>;
      const byId = new Map(known.map(row => [row.fill_id, row.fill_json]));
      for (const fill of known) quantity = quantity.plus(riskPositive((JSON.parse(fill.fill_json) as ExternalFill).quantity));
      for (const fill of reply.fills) {
        const previous = byId.get(fill.externalFillId);
        if (previous) { if (previous !== fillFingerprint(fill)) throw new Error('Conflicting external fill.'); continue; }
        quantity = quantity.plus(riskPositive(fill.quantity)); newFills.push(fill);
      }
      const requested = riskPositive(lease.intent.quantity);
      if (quantity.gt(requested) || (reply.status === 'filled' && !quantity.eq(requested)) || (reply.status === 'partially_filled' && (!quantity.gt(0) || !quantity.lt(requested))) || (['rejected', 'acknowledged'].includes(reply.status) && quantity.gt(0))) throw new Error('Invalid cumulative external fill quantity.');
      const body: SubmitExecutorReport = { reportId: randomUUID(), leaseToken: lease.leaseToken, status, ...(reply.externalOrderId ? { externalOrderId: reply.externalOrderId } : {}), fills: newFills };
      this.db.prepare('INSERT INTO reports(report_id,intent_id,body_json) VALUES(?,?,?)').run(body.reportId, lease.intent.id, JSON.stringify(body));
      for (const fill of newFills) this.db.prepare('INSERT INTO fills VALUES(?,?,?)').run(lease.intent.id, fill.externalFillId, fillFingerprint(fill));
      this.db.prepare('UPDATE orders SET last_reply=?,phase=? WHERE intent_id=?').run(signature, terminal[reply.status] ? 'observed' : 'attempted', lease.intent.id);
    })();
  }
  private async flushReports(): Promise<boolean> {
    let complete = true;
    const pending = this.db.prepare('SELECT report_id,intent_id,body_json FROM reports WHERE delivered=0 ORDER BY rowid').all() as PendingReport[];
    for (const report of pending) {
      try {
        const response = await this.options.api.request<{ intent: LiveIntent }>('/order-intents/' + report.intent_id + '/reports', { method: 'POST', body: JSON.parse(report.body_json), signal: this.stop.signal });
        this.db.transaction(() => {
          this.db.prepare('UPDATE reports SET delivered=1 WHERE report_id=?').run(report.report_id);
          const row = this.db.prepare('SELECT lease_json FROM orders WHERE intent_id=?').get(report.intent_id) as { lease_json: string };
          const lease = JSON.parse(row.lease_json) as ExecutorLease; lease.intent = response.intent;
          this.db.prepare('UPDATE orders SET lease_json=?,phase=? WHERE intent_id=?').run(JSON.stringify(lease), terminal[response.intent.state] ? 'terminal' : 'attempted', report.intent_id);
        })();
        this.emit('reported', report.intent_id, response.intent.state);
      } catch { complete = false; this.emit('report_pending', report.intent_id); break; }
    }
    return complete;
  }
  private async reconcile(lease: ExecutorLease, cancel: boolean) {
    try {
      const reply = await this.driverCall(lease, cancel ? 'cancel' : 'status', cancel ? 'cancel' : 'reconcile');
      if (reply.status === 'not_submitted') {
        const deadline = lease.intent.expiresAt;
        const previouslyAccepted = lease.intent.reports.some(report => ['acknowledged', 'partially_filled', 'filled'].includes(report.status));
        if (reply.absenceConfirmed === true && this.now() > deadline && lease.intent.filledQuantity === '0' && !previouslyAccepted) this.queue(lease, { status: cancel ? 'cancelled' : 'expired', fills: [] });
        else this.queue(lease, { status: 'unknown', fills: [] });
      } else this.queue(lease, reply);
    } catch { this.emit('driver_failed', lease.intent.id); this.queue(lease, { status: 'unknown', fills: [] }); }
  }
  private async fresh(lease: ExecutorLease) {
    try {
      const deadline = Math.min(lease.intent.expiresAt, lease.leaseExpiresAt);
      if (this.now() >= deadline) { this.queue(lease, { status: 'expired', fills: [] }); return; }
      const preflight = await this.driverCall(lease, 'status', 'preflight');
      if (preflight.status !== 'not_submitted') { this.queue(lease, preflight); return; }
      const quote = preflight.quote;
      if (!quote || quote.market.provider !== lease.intent.market.provider || quote.market.symbol !== lease.intent.market.symbol || this.now() - quote.observedAt > 30000 || quote.observedAt > this.now()) { this.queue(lease, { status: 'rejected', fills: [] }); return; }
      const quantity = riskPositive(lease.intent.quantity), step = riskPositive(lease.quantityStep), tick = riskPositive(lease.tickSize), price = riskPositive(quote.price);
      if (!quantity.mod(step).isZero() || !price.mod(tick).isZero()) { this.queue(lease, { status: 'rejected', fills: [] }); return; }
      if (lease.intent.type === 'limit' && (!lease.intent.limitPrice || !riskPositive(lease.intent.limitPrice).mod(tick).isZero())) { this.queue(lease, { status: 'rejected', fills: [] }); return; }
      if (lease.intent.type === 'market' && (!lease.minExecutionPrice || !lease.maxExecutionPrice || price.lt(riskPositive(lease.minExecutionPrice)) || price.gt(riskPositive(lease.maxExecutionPrice)))) { this.queue(lease, { status: 'rejected', fills: [] }); return; }
      // Refresh control after preflight: a kill/cancel during the driver call must not submit.
      const control = await this.control();
      const current = control.orders.find(row => row.intent.id === lease.intent.id);
      if (!current) { this.queue(lease, { status: 'unknown', fills: [] }); return; }
      this.storeLease(current, 'recovered');
      if (current.intent.cancelRequested || !control.policyEnabled) { await this.reconcile(current, true); return; }
      if (!control.executorEnabled || control.claimsPausedReason) { this.queue(current, { status: 'rejected', fills: [] }); return; }
      if (this.now() >= deadline || this.now() - quote.observedAt > 30000) { this.queue(current, { status: 'expired', fills: [] }); return; }
      // SQLite FULL commit precedes process creation. Any subsequent failure is ambiguous.
      this.db.prepare("UPDATE orders SET phase='attempted' WHERE intent_id=?").run(current.intent.id);
      try { this.queue(current, await this.driverCall(current, 'submit', 'submit')); }
      catch { this.emit('driver_failed', current.intent.id); this.queue(current, { status: 'unknown', fills: [] }); }
    } catch { this.emit('driver_failed', lease.intent.id); this.queue(lease, { status: 'unknown', fills: [] }); }
  }
  private async runCycle(): Promise<ExecutorCycleResult> {
    let reportsReady = await this.flushReports();
    const control = await this.control();
    for (const lease of control.orders) this.storeLease(lease, 'recovered');
    const rows = this.db.prepare("SELECT * FROM orders WHERE phase!='terminal' ORDER BY rowid").all() as StoredOrder[];
    for (const row of rows) {
      const lease = JSON.parse(row.lease_json) as ExecutorLease;
      await this.reconcile(lease, lease.intent.cancelRequested || !control.policyEnabled);
    }
    reportsReady = await this.flushReports() && reportsReady;
    const outstanding = this.db.prepare("SELECT intent_id,lease_json FROM orders WHERE phase!='terminal' ORDER BY rowid").all() as Array<{ intent_id: string; lease_json: string }>;
    for (const row of outstanding) {
      const lease = JSON.parse(row.lease_json) as ExecutorLease;
      if (lease.intent.state === 'unknown' || lease.intent.state === 'claimed') {
        this.emit('unresolved', lease.intent.id, lease.intent.state);
        return { intentId: lease.intent.id, state: lease.intent.state, unresolved: true };
      }
    }
    const last = rows.length ? this.db.prepare('SELECT lease_json FROM orders WHERE intent_id=?').get(rows[rows.length - 1].intent_id) as { lease_json: string } : undefined;
    const observed = last ? (JSON.parse(last.lease_json) as ExecutorLease).intent : undefined;
    const result: ExecutorCycleResult = { intentId: observed?.id ?? null, state: observed?.state ?? null, unresolved: !reportsReady };
    if (!reportsReady || !control.policyEnabled || !control.executorEnabled || control.claimsPausedReason) return result;
    const started = performance.now();
    const claim = await this.options.api.request<ExecutorClaim>('/executors/' + this.options.executorId + '/claim', { method: 'POST', signal: this.stop.signal });
    this.anchor(claim.serverTime, started);
    if (!claim.claim) return result;
    this.storeLease(claim.claim, 'recovered'); this.emit('claimed', claim.claim.intent.id, 'claimed');
    await this.fresh(claim.claim); const sent = await this.flushReports();
    const row = this.db.prepare('SELECT lease_json FROM orders WHERE intent_id=?').get(claim.claim.intent.id) as { lease_json: string };
    const state = (JSON.parse(row.lease_json) as ExecutorLease).intent.state;
    return { intentId: claim.claim.intent.id, state, unresolved: !sent || state === 'unknown' || state === 'claimed' };
  }
}
