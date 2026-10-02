import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { ExecutionAudit, ExecutionPolicy, ExecutorClaim, ExecutorCommand, ExecutorControl, ExecutorLease, ExecutorRecord, ExternalFill, InvalidationEvent, LiveAction, LiveActionResult, LiveIntent, OrderIntentRequest, RecordedExecutorReport, ReportedPosition, RiskUsage, SubmitExecutorReport, UpdateExecutionPolicy, UpdateExecutor, Instrument, Quote } from '@pineterm/contracts';
import { executionBounds, RiskDecimal, riskAligned, riskDecimal, riskPositive, riskString } from '@pineterm/domain';
import type { AppDatabase } from '../database.js';
import type { MarketService } from '../market/MarketService.js';
import type { InvalidationHub } from '../events.js';
import { ApiError } from '../errors.js';
import { SecretStore, hashToken, constantTimeEqual } from '../secrets.js';

const DAY = 86400000;
const terminal: Record<string, true> = { filled: true, rejected: true, cancelled: true, expired: true };
interface ExecutorRow { id: string; name: string; enabled: number; claims_paused_reason: string | null; revision: number; created_at: number; updated_at: number; archived_at: number | null }
interface IntentRow {
  id: string; executor_id: string; creator_key_id: string | null; idempotency_key: string; request_hash: string;
  provider: LiveAction['market']['provider']; symbol: string; side: LiveAction['side']; type: LiveAction['type']; quantity: string; limit_price: string | null;
  quote_currency: string; reference_price: string; reference_observed_at: number; maximum_deviation_bps: string; min_execution_price: string | null; max_execution_price: string | null;
  state: LiveIntent['state']; cancel_requested: number; lease_token_hash: string | null; encrypted_lease_token: string | null; lease_expires_at: number | null;
  external_order_id: string | null; revision: number; created_at: number; expires_at: number; updated_at: number; source_event_id: string | null; quantity_step: string; tick_size: string;
}
interface ReservationRow { intent_id: string; quote_currency: string; requested_notional: string; retained_notional: string; unit_risk_price: string; pending_capacity: number; created_at: number; submitted_at: number | null; resolved_at: number | null }
interface ReportRow { id: string; intent_id: string; executor_id: string; external_report_id: string; payload_hash: string; payload_json: string; response_json: string | null; created_at: number }
interface FillRow { intent_id: string; executor_id: string; external_fill_id: string; quantity: string; price: string; fee: string; currency: string; occurred_at: number }
interface ActionRow { event_id: string; action_json: string; state: LiveActionResult['state']; intent_id: string | null; error_code: string | null; error_message: string | null }
interface SignalRow { alert_id: string; alert_revision: number; payload_json: string; occurred_at: number; revision: number; archived_at: number | null; definition_json: string }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
function fingerprint(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

/** The API's reservations bound submitted notional, not a broker account or exchange portfolio. */
export class ExecutionService {
  #timer: NodeJS.Timeout | null = null;
  #closed = false;
  #worker: Promise<void> | null = null;
  #again = false;
  #events: InvalidationEvent[] | null = null;
  constructor(readonly db: AppDatabase, readonly market: MarketService, readonly secrets: SecretStore, readonly clock: () => number, readonly events: InvalidationHub) {}

  async initialise(): Promise<void> {
    this.#tx(() => {
      this.db.prepare("INSERT OR IGNORE INTO execution_policy(id,singleton,enabled,revision,policy_json,updated_at) VALUES (?,1,0,1,?,?)").run(randomUUID(), JSON.stringify({ allowlist: [], quoteLimits: [], maxPending: null, maxDeviationBps: null }), this.clock());
      for (const row of this.db.prepare<[], IntentRow>("SELECT * FROM live_intents WHERE state='claimed'").all()) this.#state(row, 'unknown', 'restart_ambiguous');
      this.#sweep();
    });
    this.#timer = setInterval(() => this.wake(), 1000); this.#timer.unref();
    this.wake(); await this.idle();
  }
  async close(): Promise<void> { this.#closed = true; clearInterval(this.#timer ?? undefined); await this.#worker; }
  async idle(): Promise<void> { this.wake(); while (this.#worker) await this.#worker; }
  wake(): void {
    if (this.#closed) return;
    this.#again = true;
    if (this.#worker) return;
    this.#worker = Promise.resolve().then(async () => {
      do {
        this.#again = false;
        this.#tx(() => this.#sweep());
        for (const row of this.db.prepare<[], ActionRow>("SELECT * FROM alert_live_actions WHERE state='pending' ORDER BY created_at,event_id").all()) {
          if (this.#closed) break;
          try {
            const signal = this.#signal(row.event_id, JSON.parse(row.action_json) as LiveAction);
            await this.createIntent({ ...JSON.parse(row.action_json) as LiveAction, expiresAt: signal.occurred_at + 60000 }, 'alert:' + row.event_id, null, row.event_id);
          } catch (error) {
            const failure = error instanceof ApiError ? error : new ApiError(503, 'EXECUTION_UNAVAILABLE', 'The live action could not be evaluated.');
            this.#tx(() => {
              const updated = this.db.prepare("UPDATE alert_live_actions SET state='failed',error_code=?,error_message=?,completed_at=? WHERE event_id=? AND state='pending'").run(failure.code, failure.message, this.clock(), row.event_id);
              if (updated.changes) { this.#audit(null, null, 'alert_action_failed', { eventId: row.event_id, code: failure.code }); this.#notifyAlert(row.event_id); }
            });
          }
        }
      } while (this.#again && !this.#closed);
    }).finally(() => { this.#worker = null; });
  }

  listExecutors(): ExecutorRecord[] { return this.db.prepare<[], ExecutorRow>('SELECT * FROM executors ORDER BY created_at,id').all().map(row => this.#executor(row)); }
  getExecutor(id: string): ExecutorRecord {
    const row = this.db.prepare<[string], ExecutorRow>('SELECT * FROM executors WHERE id=?').get(id);
    if (!row) throw new ApiError(404, 'EXECUTOR_NOT_FOUND', 'The executor does not exist.');
    return this.#executor(row);
  }
  createExecutor(body: ExecutorCommand): ExecutorRecord {
    this.#executorSyntax(body);
    const id = randomUUID();
    this.#tx(() => {
      this.db.prepare('INSERT INTO executors(id,name,enabled,revision,created_at,updated_at) VALUES (?,?,?,1,?,?)').run(id, body.name.trim(), Number(body.enabled), this.clock(), this.clock());
      this.#audit(null, id, 'executor_created', { enabled: body.enabled }); this.#notify(id, 1);
    });
    return this.getExecutor(id);
  }
  updateExecutor(id: string, body: UpdateExecutor): ExecutorRecord {
    this.#executorSyntax(body);
    this.#tx(() => {
      const current = this.getExecutor(id);
      if (current.archivedAt !== null || current.revision !== body.revision) throw new ApiError(409, 'REVISION_CONFLICT', 'Reload the executor before updating it.');
      this.db.prepare('UPDATE executors SET name=?,enabled=?,revision=revision+1,updated_at=? WHERE id=?').run(body.name.trim(), Number(body.enabled), this.clock(), id);
      if (!body.enabled) this.#kill(id);
      this.#audit(null, id, 'executor_updated', { enabled: body.enabled }); this.#notify(id, current.revision + 1);
    });
    return this.getExecutor(id);
  }
  deleteExecutor(id: string): void {
    this.#tx(() => {
      const current = this.getExecutor(id);
      if (current.archivedAt !== null) return;
      this.db.prepare('UPDATE executors SET enabled=0,archived_at=?,updated_at=?,revision=revision+1 WHERE id=?').run(this.clock(), this.clock(), id);
      this.#kill(id); this.#audit(null, id, 'executor_archived', {}); this.#notify(id, current.revision + 1);
    });
  }
  getPolicy(): ExecutionPolicy {
    const row = this.db.prepare<[], { revision: number; enabled: number; policy_json: string; updated_at: number }>('SELECT * FROM execution_policy WHERE singleton=1').get();
    if (!row) return { revision: 1, enabled: false, allowlist: [], quoteLimits: [], maxPending: null, maxDeviationBps: null, updatedAt: null };
    return { ...JSON.parse(row.policy_json) as Omit<ExecutionPolicy, 'enabled' | 'revision' | 'updatedAt'>, revision: row.revision, enabled: !!row.enabled, updatedAt: row.updated_at };
  }
  async updatePolicy(body: UpdateExecutionPolicy): Promise<ExecutionPolicy> {
    if (body.enabled) {
      if (!Array.isArray(body.allowlist) || !body.allowlist.length || !Array.isArray(body.quoteLimits) || !body.quoteLimits.length || !Number.isSafeInteger(body.maxPending) || body.maxPending < 1 || body.maxPending > 1000) throw new ApiError(422, 'INVALID_EXECUTION_POLICY', 'Explicit allowlist, quote limits and maxPending (1–1000) are required.');
      try {
        const deviation = riskDecimal(body.maxDeviationBps);
        if (deviation.isNegative() || deviation.gte(10000)) throw new Error();
        const currencies = new Set<string>();
        for (const limit of body.quoteLimits) {
          if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(limit.quoteCurrency) || currencies.has(limit.quoteCurrency)) throw new Error();
          riskPositive(limit.perOrderNotional); riskPositive(limit.rolling24hNotional); currencies.add(limit.quoteCurrency);
        }
        const markets = new Set<string>();
        for (const rule of body.allowlist) {
          const key = rule.market.provider + ':' + rule.market.symbol;
          if (rule.market.provider === 'csv' || markets.has(key) || !rule.sides.length || rule.sides.some(side => side !== 'buy' && side !== 'sell') || new Set(rule.sides).size !== rule.sides.length) throw new Error();
          markets.add(key);
          const metadata = await this.market.getInstrument(rule.market);
          if (!currencies.has(metadata.quoteCurrency)) throw new Error();
        }
      } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(422, 'INVALID_EXECUTION_POLICY', 'Limits must be positive canonical decimals, deviation in [0,10000) bps, and every allowed market must have its exact quote currency limit.'); }
    }
    this.#tx(() => {
      const current = this.getPolicy();
      if (current.revision !== body.revision) throw new ApiError(409, 'REVISION_CONFLICT', 'Reload the execution policy before updating it.');
      if (body.enabled && !this.listExecutors().some(executor => executor.enabled && executor.archivedAt === null)) throw new ApiError(422, 'EXECUTOR_REQUIRED', 'Register and enable an executor before enabling live handoff.');
      const policy = body.enabled ? { allowlist: body.allowlist, quoteLimits: body.quoteLimits, maxPending: body.maxPending, maxDeviationBps: body.maxDeviationBps } : { allowlist: current.allowlist, quoteLimits: current.quoteLimits, maxPending: current.maxPending, maxDeviationBps: current.maxDeviationBps };
      this.db.prepare('UPDATE execution_policy SET enabled=?,revision=revision+1,policy_json=?,updated_at=? WHERE singleton=1').run(Number(body.enabled), JSON.stringify(policy), this.clock());
      if (!body.enabled) this.#kill();
      this.#audit(null, null, body.enabled ? 'policy_enabled' : 'policy_killed', { revision: current.revision + 1 });
      const id = this.db.prepare<[], { id: string }>('SELECT id FROM execution_policy WHERE singleton=1').get()!.id; this.#notify(id, current.revision + 1);
    });
    return this.getPolicy();
  }

  async validateLiveAction(body: LiveAction): Promise<void> {
    this.#actionSyntax(body);
    const executor = this.getExecutor(body.executorId);
    if (executor.archivedAt !== null) throw new ApiError(422, 'EXECUTOR_ARCHIVED', 'Choose a registered nonarchived executor.');
    this.#instrument(body, await this.market.getInstrument(body.market));
  }
  async createIntent(body: OrderIntentRequest, key: string, creatorKeyId: string | null, sourceEventId?: string): Promise<LiveIntent> {
    this.#actionSyntax(body, true);
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key)) throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', 'Provide a bounded printable Idempotency-Key.');
    if (!sourceEventId && key.startsWith('alert:')) throw new ApiError(400, 'RESERVED_IDEMPOTENCY_KEY', 'alert: keys belong to durable server signal actions.');
    if (sourceEventId && (key !== 'alert:' + sourceEventId || creatorKeyId !== null)) throw new ApiError(409, 'ALERT_ACTION_INVALIDATED', 'Signal provenance requires the durable server action key and creator.');
    const hash = fingerprint({ body, creatorKeyId, sourceEventId: sourceEventId ?? null });
    const prior = this.#prior(body.executorId, key, hash);
    if (prior) return this.getIntent(prior.id);
    if (sourceEventId) this.#signal(sourceEventId, body);
    this.#expires(body.expiresAt);
    this.#allow(body);
    const metadata = await this.market.getInstrument(body.market);
    const quote = await this.market.getQuote(body.market);
    let id = '';
    this.#tx(() => {
      const duplicate = this.#prior(body.executorId, key, hash);
      if (duplicate) { id = duplicate.id; return; }
      this.#sweep();
      if (sourceEventId) this.#signal(sourceEventId, body);
      this.#expires(body.expiresAt); this.#instrument(body, metadata); this.#fresh(quote, body);
      const policy = this.#allow(body);
      const bounds = executionBounds(body, quote.price, policy.maxDeviationBps!);
      this.#limits(metadata.quoteCurrency, bounds.notional, policy);
      id = randomUUID(); const now = this.clock();
      this.db.prepare('INSERT INTO live_intents(id,executor_id,creator_key_id,idempotency_key,request_hash,provider,symbol,side,type,quantity,limit_price,quote_currency,reference_price,maximum_deviation_bps,state,cancel_requested,revision,created_at,expires_at,updated_at,reference_observed_at,source_event_id,min_execution_price,max_execution_price,quantity_step,tick_size) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,\'pending\',0,1,?,?,?,?,?,?,?,?,?)').run(id, body.executorId, creatorKeyId, key, hash, body.market.provider, body.market.symbol, body.side, body.type, body.quantity, body.limitPrice ?? null, metadata.quoteCurrency, quote.price, policy.maxDeviationBps!, now, body.expiresAt, now, quote.observedAt, sourceEventId ?? null, bounds.minimum, bounds.maximum, metadata.quantityStep, metadata.tickSize);
      this.db.prepare('INSERT INTO risk_reservations(id,intent_id,quote_currency,requested_notional,retained_notional,pending_capacity,created_at,unit_risk_price) VALUES (?,?,?,?,?,1,?,?)').run(randomUUID(), id, metadata.quoteCurrency, bounds.notional, bounds.notional, now, bounds.unitRiskPrice);
      if (sourceEventId) { this.db.prepare("UPDATE alert_live_actions SET state='created',intent_id=?,completed_at=? WHERE event_id=? AND state='pending'").run(id, now, sourceEventId); this.#notifyAlert(sourceEventId); }
      this.#audit(id, body.executorId, 'intent_created', { requestedNotional: bounds.notional, quoteCurrency: metadata.quoteCurrency, sourceEventId: sourceEventId ?? null }); this.#notify(id, 1);
    });
    return this.getIntent(id);
  }
  getIntent(id: string): LiveIntent {
    const row = this.#row(id);
    const risk = this.db.prepare<[string], ReservationRow>('SELECT * FROM risk_reservations WHERE intent_id=?').get(id)!;
    // Reports are append-only; equal timestamps must retain acceptance order, not random UUID order.
    const reports = this.db.prepare<[string], ReportRow>('SELECT * FROM executor_reports WHERE intent_id=? ORDER BY created_at,rowid').all(id).map(report => ({ ...JSON.parse(report.payload_json) as Omit<SubmitExecutorReport, 'leaseToken'>, id: report.id, intentId: id, executorId: report.executor_id, createdAt: report.created_at } satisfies RecordedExecutorReport));
    const fills = this.db.prepare<[string], FillRow>('SELECT * FROM executor_fills WHERE intent_id=?').all(id);
    return { id, executorId: row.executor_id, market: { provider: row.provider, symbol: row.symbol }, side: row.side, type: row.type, quantity: row.quantity, ...(row.limit_price === null ? {} : { limitPrice: row.limit_price }), expiresAt: row.expires_at, quoteCurrency: row.quote_currency, referencePrice: row.reference_price, referenceObservedAt: row.reference_observed_at, maximumDeviationBps: row.maximum_deviation_bps, minExecutionPrice: row.min_execution_price, maxExecutionPrice: row.max_execution_price, state: row.state, cancelRequested: !!row.cancel_requested, leaseExpiresAt: row.lease_expires_at, externalOrderId: row.external_order_id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, sourceEventId: row.source_event_id, filledQuantity: riskString(fills.reduce((sum, fill) => sum.plus(fill.quantity), new RiskDecimal(0))), risk: { requestedNotional: risk.requested_notional, retainedNotional: risk.retained_notional, pendingCapacity: !!risk.pending_capacity, resolvedAt: risk.resolved_at }, reports };
  }
  listIntents(): LiveIntent[] { return this.db.prepare<[], { id: string }>('SELECT id FROM live_intents ORDER BY created_at DESC,id').all().map(row => this.getIntent(row.id)); }
  cancelIntent(id: string): LiveIntent {
    this.#tx(() => {
      const row = this.#row(id);
      if (terminal[row.state]) return;
      if (row.state === 'pending') this.#state(row, 'cancelled', 'pending_cancelled');
      else this.#requestCancel(row);
    });
    return this.getIntent(id);
  }
  async claim(executorId: string): Promise<ExecutorClaim> {
    this.#tx(() => this.#sweep());
    const executor = this.getExecutor(executorId);
    if (!executor.enabled || executor.archivedAt !== null || executor.claimsPausedReason || !this.getPolicy().enabled) return { claim: null, serverTime: this.clock() };
    const candidates = this.db.prepare<[string], IntentRow>("SELECT * FROM live_intents WHERE executor_id=? AND state='pending' ORDER BY created_at,id").all(executorId);
    for (const candidate of candidates) {
      const body = this.getIntent(candidate.id);
      let metadata: Instrument; let quote: Quote;
      try { metadata = await this.market.getInstrument(body.market); quote = await this.market.getQuote(body.market); } catch (error) { if (error instanceof ApiError && [429,503].includes(error.statusCode)) continue; throw error; }
      let lease: ExecutorLease | null = null;
      this.#tx(() => {
        this.#sweep(); const row = this.#row(candidate.id);
        if (row.state !== 'pending') return;
        try {
          if (row.source_event_id) this.#signal(row.source_event_id, body, 'created');
          this.#expires(row.expires_at); this.#instrument(body, metadata); this.#fresh(quote, body);
          const policy = this.#allow(body);
          if (metadata.quoteCurrency !== row.quote_currency) throw new ApiError(422, 'INSTRUMENT_CHANGED', 'Instrument quote currency changed; create a new intent.');
          const deviation = riskString(RiskDecimal.min(riskDecimal(row.maximum_deviation_bps), riskDecimal(policy.maxDeviationBps!)));
          const bounds = executionBounds(body, body.type === 'market' ? row.reference_price : quote.price, deviation);
          if (body.type === 'market' && (riskDecimal(quote.price).lt(new RiskDecimal(bounds.minimum!)) || riskDecimal(quote.price).gt(new RiskDecimal(bounds.maximum!)))) throw new ApiError(422, 'REFERENCE_PRICE_DEVIATION', 'The fresh quote moved outside the original intent reference price band.');
          const risk = this.db.prepare<[string], ReservationRow>('SELECT * FROM risk_reservations WHERE intent_id=?').get(row.id)!;
          const amount = riskString(RiskDecimal.max(new RiskDecimal(risk.requested_notional), new RiskDecimal(bounds.notional)));
          this.#limits(row.quote_currency, amount, policy, row.id);
          const token = randomBytes(32).toString('base64url'); const now = this.clock();
          this.db.prepare("UPDATE live_intents SET state='claimed',lease_token_hash=?,encrypted_lease_token=?,lease_expires_at=?,maximum_deviation_bps=?,min_execution_price=?,max_execution_price=?,quantity_step=?,tick_size=?,revision=revision+1,updated_at=? WHERE id=?").run(hashToken(token), this.secrets.encrypt(token, 'execution-lease:' + row.id), now + 30000, deviation, bounds.minimum, bounds.maximum, metadata.quantityStep, metadata.tickSize, now, row.id);
          this.db.prepare('UPDATE risk_reservations SET requested_notional=?,retained_notional=?,unit_risk_price=?,submitted_at=? WHERE intent_id=?').run(amount, amount, riskString(new RiskDecimal(amount).div(row.quantity)), now, row.id);
          this.#audit(row.id, executorId, 'intent_claimed', { clientOrderId: row.id, leaseExpiresAt: now + 30000, verifiedQuotePrice: quote.price, verifiedQuoteObservedAt: quote.observedAt }); this.#notify(row.id, row.revision + 1);
          lease = this.#lease(this.#row(row.id));
        } catch (error) {
          if (error instanceof ApiError && ['STALE_QUOTE','EXECUTOR_UNRESOLVED','LIVE_EXECUTION_DISABLED','EXECUTOR_DISABLED'].includes(error.code)) return;
          if (!(error instanceof ApiError)) throw error;
          this.#state(row, 'rejected', 'claim_rejected', { code: error.code });
        }
      });
      if (lease) return { claim: lease, serverTime: this.clock() };
    }
    return { claim: null, serverTime: this.clock() };
  }
  control(executorId: string): ExecutorControl {
    this.#tx(() => this.#sweep());
    const executor = this.getExecutor(executorId);
    const orders = this.db.prepare<[string], IntentRow>("SELECT * FROM live_intents WHERE executor_id=? AND state IN ('claimed','acknowledged','partially_filled','unknown') ORDER BY created_at,id").all(executorId).map(row => this.#lease(row));
    return { executorId, executorEnabled: executor.enabled && executor.archivedAt === null, policyEnabled: this.getPolicy().enabled, claimsPausedReason: executor.claimsPausedReason, serverTime: this.clock(), orders };
  }
  report(intentId: string, executorId: string, body: SubmitExecutorReport): LiveIntent {
    const { leaseToken, ...payload } = body;
    let result: LiveIntent | null = null;
    this.#tx(() => {
      this.#sweep(); const row = this.#row(intentId);
      if (row.executor_id !== executorId || !row.lease_token_hash || typeof leaseToken !== 'string' || !constantTimeEqual(row.lease_token_hash, hashToken(leaseToken))) throw new ApiError(403, 'EXECUTOR_FORBIDDEN', 'The executor binding or original lease token is invalid.');
      this.#reportSyntax(payload);
      const hash = fingerprint(payload);
      const prior = this.db.prepare<[string, string], ReportRow>('SELECT * FROM executor_reports WHERE executor_id=? AND external_report_id=?').get(executorId, body.reportId);
      if (prior) {
        if (prior.intent_id !== intentId || prior.payload_hash !== hash) throw new ApiError(409, 'REPORT_CONFLICT', 'This report ID was already used for a different outcome.');
        result = JSON.parse(prior.response_json!) as LiveIntent; return;
      }
      if (terminal[row.state] || row.state === 'pending') throw new ApiError(409, 'INVALID_REPORT_TRANSITION', 'This intent does not accept a new report.');
      if (row.external_order_id && body.externalOrderId && row.external_order_id !== body.externalOrderId) throw new ApiError(409, 'EXTERNAL_ORDER_CONFLICT', 'The external order ID cannot change.');
      const existing = this.db.prepare<[string], FillRow>('SELECT * FROM executor_fills WHERE intent_id=?').all(intentId);
      let quantity = existing.reduce((sum, fill) => sum.plus(fill.quantity), new RiskDecimal(0));
      const additions: ExternalFill[] = []; const seen = new Set<string>();
      for (const fill of body.fills) {
        if (seen.has(fill.externalFillId)) throw new ApiError(409, 'FILL_CONFLICT', 'A report repeats a fill ID.'); seen.add(fill.externalFillId);
        const old = this.db.prepare<[string, string], FillRow>('SELECT * FROM executor_fills WHERE executor_id=? AND external_fill_id=?').get(executorId, fill.externalFillId);
        if (old) {
          if (old.intent_id !== intentId || canonical({ externalFillId: old.external_fill_id, quantity: old.quantity, price: old.price, fee: old.fee, currency: old.currency, time: old.occurred_at }) !== canonical(fill)) throw new ApiError(409, 'FILL_CONFLICT', 'This fill ID was already used for different data.');
          continue;
        }
        const price = riskPositive(fill.price);
        if ((row.side === 'buy' && row.max_execution_price !== null && price.gt(riskDecimal(row.max_execution_price))) || (row.side === 'sell' && row.min_execution_price !== null && price.lt(riskDecimal(row.min_execution_price)))) throw new ApiError(422, 'EXECUTION_PRICE_BOUND', 'The reported fill exceeds the protected buy cap or sell floor.');
        quantity = quantity.plus(fill.quantity); additions.push(fill);
      }
      const requested = riskDecimal(row.quantity);
      if (quantity.gt(requested) || (body.status === 'filled' && !quantity.eq(requested)) || (body.status === 'partially_filled' && (!quantity.gt(0) || quantity.gte(requested))) || (body.status === 'acknowledged' && quantity.gt(0)) || (body.status === 'rejected' && quantity.gt(0)) || (row.state === 'partially_filled' && body.status === 'acknowledged')) throw new ApiError(409, 'INVALID_REPORT_TRANSITION', 'Reported state must agree with monotonic cumulative filled quantity.');
      const now = this.clock();
      for (const fill of additions) this.db.prepare('INSERT INTO executor_fills(id,intent_id,executor_id,external_fill_id,quantity,price,fee,currency,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), intentId, executorId, fill.externalFillId, fill.quantity, fill.price, fill.fee, fill.currency, fill.time, now);
      this.db.prepare('UPDATE live_intents SET external_order_id=COALESCE(external_order_id,?) WHERE id=?').run(body.externalOrderId ?? null, intentId);
      this.#state(row, body.status, 'executor_report', { reportId: body.reportId, addedFillIds: additions.map(fill => fill.externalFillId) });
      const id = randomUUID();
      this.db.prepare('INSERT INTO executor_reports(id,intent_id,executor_id,external_report_id,payload_hash,payload_json,created_at) VALUES (?,?,?,?,?,?,?)').run(id, intentId, executorId, body.reportId, hash, JSON.stringify(payload), now);
      result = this.getIntent(intentId);
      this.db.prepare('UPDATE executor_reports SET response_json=? WHERE id=?').run(JSON.stringify(result), id);
    });
    return result!;
  }

  usage(): RiskUsage[] {
    const currencies = new Map<string, RiskUsage>();
    for (const row of this.db.prepare<[], ReservationRow>('SELECT * FROM risk_reservations').all()) {
      const active = !!row.pending_capacity; const recent = (row.submitted_at ?? row.created_at) > this.clock() - DAY;
      if (!active && !recent) continue;
      const value = currencies.get(row.quote_currency) ?? { quoteCurrency: row.quote_currency, rolling24hNotional: '0', unresolvedNotional: '0', pendingIntents: 0 };
      value.rolling24hNotional = riskString(new RiskDecimal(value.rolling24hNotional).plus(row.retained_notional));
      if (active) { value.unresolvedNotional = riskString(new RiskDecimal(value.unresolvedNotional).plus(row.retained_notional)); value.pendingIntents++; }
      currencies.set(row.quote_currency, value);
    }
    return [...currencies.values()].sort((a, b) => a.quoteCurrency.localeCompare(b.quoteCurrency));
  }
  reportedPositions(): ReportedPosition[] {
    const positions = new Map<string, ReportedPosition>();
    const fills = this.db.prepare<[], FillRow & { provider: LiveAction['market']['provider']; symbol: string; side: LiveAction['side']; quote_currency: string }>('SELECT f.*,i.provider,i.symbol,i.side,i.quote_currency FROM executor_fills f JOIN live_intents i ON i.id=f.intent_id ORDER BY f.occurred_at,f.id').all();
    for (const fill of fills) {
      const key = `${fill.executor_id}:${fill.provider}:${fill.symbol}`;
      const position = positions.get(key) ?? { executorId: fill.executor_id, market: { provider: fill.provider, symbol: fill.symbol }, quoteCurrency: fill.quote_currency, netQuantity: '0', boughtQuantity: '0', soldQuantity: '0', boughtNotional: '0', soldNotional: '0', fees: {}, lastFillAt: fill.occurred_at };
      const quantityKey = fill.side === 'buy' ? 'boughtQuantity' : 'soldQuantity'; const notionalKey = fill.side === 'buy' ? 'boughtNotional' : 'soldNotional';
      position[quantityKey] = riskString(new RiskDecimal(position[quantityKey]).plus(fill.quantity)); position[notionalKey] = riskString(new RiskDecimal(position[notionalKey]).plus(new RiskDecimal(fill.quantity).mul(fill.price)));
      position.netQuantity = riskString(new RiskDecimal(position.boughtQuantity).minus(position.soldQuantity)); position.fees[fill.currency] = riskString(new RiskDecimal(position.fees[fill.currency] ?? '0').plus(fill.fee)); position.lastFillAt = Math.max(position.lastFillAt, fill.occurred_at);
      positions.set(key, position);
    }
    return [...positions.values()];
  }
  audit(): ExecutionAudit[] {
    return this.db.prepare<[], { id: string; intent_id: string | null; executor_id: string | null; type: string; details_json: string; created_at: number }>('SELECT * FROM execution_audit ORDER BY created_at,id').all().map(row => ({ id: row.id, intentId: row.intent_id, executorId: row.executor_id, type: row.type, details: JSON.parse(row.details_json) as Record<string, unknown>, createdAt: row.created_at }));
  }
  enqueueAlertAction(eventId: string, action: LiveAction, now: number): void {
    this.#actionSyntax(action);
    this.#signal(eventId, action, 'enqueuing');
    this.db.prepare("INSERT OR IGNORE INTO alert_live_actions(event_id,action_json,state,created_at) VALUES (?,?,'pending',?)").run(eventId, JSON.stringify(action), now);
  }
  getAlertAction(eventId: string): LiveActionResult | undefined {
    const row = this.db.prepare<[string], ActionRow>('SELECT * FROM alert_live_actions WHERE event_id=?').get(eventId);
    return row ? { state: row.state, intentId: row.intent_id, error: row.error_code ? { code: row.error_code, message: row.error_message! } : null } : undefined;
  }

  #tx<T>(fn: () => T): T {
    if (this.#events) return fn();
    const notifications: InvalidationEvent[] = []; this.#events = notifications;
    try { const result = this.db.transaction(fn).immediate(); this.#events = null; for (const event of notifications) this.events.emit(event); return result; }
    finally { this.#events = null; }
  }
  #notify(id: string, revision: number): void { this.#events!.push(this.events.record('live-intents.changed', id, revision)); }
  #notifyAlert(eventId: string): void {
    const row = this.db.prepare<[string], { alert_id: string; revision: number }>('SELECT e.alert_id,a.revision FROM alert_events e JOIN alerts a ON a.id=e.alert_id WHERE e.id=?').get(eventId);
    if (row) this.#events!.push(this.events.record('alerts.changed', row.alert_id, row.revision));
  }
  #audit(intentId: string | null, executorId: string | null, type: string, details: Record<string, unknown>): void { this.db.prepare('INSERT INTO execution_audit(id,intent_id,executor_id,type,details_json,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), intentId, executorId, type, JSON.stringify(details), this.clock()); }
  #executor(row: ExecutorRow): ExecutorRecord { return { id: row.id, name: row.name, enabled: !!row.enabled, claimsPausedReason: row.claims_paused_reason, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at }; }
  #executorSyntax(body: ExecutorCommand): void { if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 || typeof body.enabled !== 'boolean') throw new ApiError(400, 'INVALID_EXECUTOR', 'Provide a name and explicit enabled state.'); }
  #row(id: string): IntentRow {
    const row = this.db.prepare<[string], IntentRow>('SELECT * FROM live_intents WHERE id=?').get(id);
    if (!row) throw new ApiError(404, 'INTENT_NOT_FOUND', 'The order intent does not exist.');
    return row;
  }
  #prior(executorId: string, key: string, hash: string): IntentRow | undefined {
    const row = this.db.prepare<[string, string], IntentRow>('SELECT * FROM live_intents WHERE executor_id=? AND idempotency_key=?').get(executorId, key);
    if (row && row.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used with a different request or principal.');
    return row;
  }
  #actionSyntax(body: LiveAction, intent = false): void {
    const keys: Record<string, true | undefined> = { executorId: true, market: true, side: true, type: true, quantity: true, limitPrice: true, expiresAt: intent ? true : undefined };
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !keys[key]) || !body.market || Object.keys(body.market).some(key => !['provider','symbol'].includes(key)) || !['coinbase','binance','csv'].includes(body.market.provider) || typeof body.market.symbol !== 'string' || !body.market.symbol || !/^[a-f0-9-]{36}$/.test(body.executorId) || !['buy','sell'].includes(body.side) || !['market','limit'].includes(body.type) || (body.type === 'limit') !== (body.limitPrice !== undefined)) throw new ApiError(400, 'INVALID_LIVE_ACTION', 'Provide only the fixed live action fields and limitPrice only for limit orders.');
    if (body.market.provider === 'csv') throw new ApiError(422, 'HISTORICAL_EXECUTION_FORBIDDEN', 'Imported, replay and backtest data cannot create live intents.');
    try { riskPositive(body.quantity); if (body.limitPrice !== undefined) riskPositive(body.limitPrice); } catch { throw new ApiError(422, 'INVALID_ORDER_AMOUNT', 'Quantity and limit price must be positive canonical decimal strings.'); }
  }
  #instrument(body: LiveAction, metadata: Instrument): void {
    try {
      if (metadata.market.provider !== body.market.provider || metadata.market.symbol !== body.market.symbol || !/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(metadata.quoteCurrency) || !riskAligned(body.quantity, metadata.quantityStep) || (body.limitPrice !== undefined && !riskAligned(body.limitPrice, metadata.tickSize))) throw new Error();
      riskPositive(metadata.tickSize);
    } catch { throw new ApiError(422, 'INVALID_ORDER_PRECISION', 'Quantity/price must follow authoritative instrument steps and quote currency.'); }
  }
  #fresh(quote: Quote, body: LiveAction): void {
    if (quote.status !== 'live' || quote.observedAt > this.clock() || this.clock() - quote.observedAt > 30000 || quote.market.provider !== body.market.provider || quote.market.symbol !== body.market.symbol) throw new ApiError(503, 'STALE_QUOTE', 'A same-market live quote observed within 30 seconds is required.');
    try { riskPositive(quote.price); } catch { throw new ApiError(503, 'INVALID_QUOTE', 'The authoritative quote is invalid.'); }
  }
  #expires(expiresAt: number): void { if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.clock() || expiresAt > this.clock() + 60000) throw new ApiError(422, 'INVALID_INTENT_EXPIRY', 'expiresAt must be in the next 60 seconds.'); }
  #allow(body: LiveAction): ExecutionPolicy {
    const policy = this.getPolicy(); const executor = this.getExecutor(body.executorId);
    if (!policy.enabled) throw new ApiError(403, 'LIVE_EXECUTION_DISABLED', 'Live handoff is disabled.');
    if (!executor.enabled || executor.archivedAt !== null) throw new ApiError(403, 'EXECUTOR_DISABLED', 'The executor is disabled or archived.');
    if (executor.claimsPausedReason) throw new ApiError(409, 'EXECUTOR_UNRESOLVED', 'Reconcile every unknown outcome before creating or claiming another intent.');
    if (!policy.allowlist.some(rule => rule.market.provider === body.market.provider && rule.market.symbol === body.market.symbol && rule.sides.includes(body.side))) throw new ApiError(403, 'MARKET_SIDE_FORBIDDEN', 'This market and side are not explicitly allowed.');
    return policy;
  }
  #limits(currency: string, notional: string, policy: ExecutionPolicy, replacing?: string): void {
    const limit = policy.quoteLimits.find(value => value.quoteCurrency === currency);
    if (!limit || new RiskDecimal(notional).gt(riskDecimal(limit.perOrderNotional))) throw new ApiError(422, 'PER_ORDER_RISK_LIMIT', 'The order exceeds its exact quote-currency per-order submitted-notional limit.');
    let pending = 0; let rolling = new RiskDecimal(0);
    for (const row of this.db.prepare<[], ReservationRow>('SELECT * FROM risk_reservations').all()) {
      if (row.intent_id === replacing) continue;
      if (row.pending_capacity) pending++;
      if (row.quote_currency === currency && (row.pending_capacity || (row.submitted_at ?? row.created_at) > this.clock() - DAY)) rolling = rolling.plus(row.retained_notional);
    }
    if (pending + 1 > policy.maxPending!) throw new ApiError(429, 'PENDING_RISK_LIMIT', 'The maximum pending intent capacity is reserved.');
    if (rolling.plus(notional).gt(riskDecimal(limit.rolling24hNotional))) throw new ApiError(422, 'ROLLING_RISK_LIMIT', 'The rolling submitted-notional limit is reserved in this quote currency.');
  }
  #lease(row: IntentRow): ExecutorLease {
    if (!row.encrypted_lease_token || row.lease_expires_at === null) throw new ApiError(503, 'LEASE_RECOVERY_UNAVAILABLE', 'The original encrypted lease could not be recovered.');
    return { intent: this.getIntent(row.id), clientOrderId: row.id, leaseToken: this.secrets.decrypt(row.encrypted_lease_token, 'execution-lease:' + row.id), leaseExpiresAt: row.lease_expires_at, quoteCurrency: row.quote_currency, quantityStep: row.quantity_step, tickSize: row.tick_size, minExecutionPrice: row.min_execution_price, maxExecutionPrice: row.max_execution_price };
  }
  #state(row: IntentRow, state: LiveIntent['state'], reason: string, details: Record<string, unknown> = {}): void {
    const now = this.clock();
    this.db.prepare('UPDATE live_intents SET state=?,updated_at=?,revision=revision+1 WHERE id=?').run(state, now, row.id);
    const risk = this.db.prepare<[string], ReservationRow>('SELECT * FROM risk_reservations WHERE intent_id=?').get(row.id)!;
    const fills = this.db.prepare<[string], FillRow>('SELECT * FROM executor_fills WHERE intent_id=?').all(row.id);
    const quantity = fills.reduce((sum, fill) => sum.plus(fill.quantity), new RiskDecimal(0));
    const actual = fills.reduce((sum, fill) => sum.plus(new RiskDecimal(fill.quantity).mul(fill.price)), new RiskDecimal(0));
    if (terminal[state]) {
      const retained = state === 'filled' ? RiskDecimal.max(new RiskDecimal(risk.requested_notional), actual) : RiskDecimal.max(quantity.mul(risk.unit_risk_price), actual);
      this.db.prepare('UPDATE risk_reservations SET retained_notional=?,pending_capacity=0,resolved_at=? WHERE intent_id=?').run(riskString(retained), now, row.id);
    } else {
      const remaining = new RiskDecimal(row.quantity).minus(quantity).mul(risk.unit_risk_price);
      const retained = RiskDecimal.max(new RiskDecimal(risk.retained_notional), new RiskDecimal(risk.requested_notional), actual.plus(remaining));
      this.db.prepare('UPDATE risk_reservations SET retained_notional=? WHERE intent_id=?').run(riskString(retained), row.id);
    }
    this.#pause(row.executor_id); this.#audit(row.id, row.executor_id, reason, { from: row.state, state, ...details }); this.#notify(row.id, row.revision + 1);
  }
  #pause(executorId: string): void {
    const unknown = this.db.prepare<[string], { count: number }>("SELECT count(*) AS count FROM live_intents WHERE executor_id=? AND state='unknown'").get(executorId)!.count;
    this.db.prepare('UPDATE executors SET claims_paused_reason=? WHERE id=?').run(unknown ? 'Unknown external outcome: reconcile by clientOrderId before resuming.' : null, executorId);
  }
  #requestCancel(row: IntentRow): void {
    if (row.cancel_requested) return;
    this.db.prepare('UPDATE live_intents SET cancel_requested=1,revision=revision+1,updated_at=? WHERE id=?').run(this.clock(), row.id);
    this.#audit(row.id, row.executor_id, 'cancel_requested', { state: row.state }); this.#notify(row.id, row.revision + 1);
  }
  #kill(executorId?: string): void {
    const rows = executorId ? this.db.prepare<[string], IntentRow>("SELECT * FROM live_intents WHERE executor_id=? AND state NOT IN ('filled','rejected','cancelled','expired')").all(executorId) : this.db.prepare<[], IntentRow>("SELECT * FROM live_intents WHERE state NOT IN ('filled','rejected','cancelled','expired')").all();
    for (const row of rows) { if (row.state === 'pending') this.#state(row, 'cancelled', 'unsubmitted_kill_cancelled'); else this.#requestCancel(row); }
  }
  #sweep(): void {
    for (const row of this.db.prepare<[number, number], IntentRow>("SELECT * FROM live_intents WHERE (state='pending' AND expires_at<=?) OR (state='claimed' AND lease_expires_at<=?)").all(this.clock(), this.clock())) this.#state(row, row.state === 'claimed' ? 'unknown' : 'expired', row.state === 'claimed' ? 'lease_outcome_unknown' : 'pending_expired');
  }
  #reportSyntax(body: Omit<SubmitExecutorReport, 'leaseToken'>): void {
    if (typeof body.reportId !== 'string' || !body.reportId || body.reportId.length > 200 || !['acknowledged','partially_filled','filled','rejected','cancelled','expired','unknown'].includes(body.status) || !Array.isArray(body.fills) || body.fills.length > 1000 || (body.externalOrderId !== undefined && (!body.externalOrderId || body.externalOrderId.length > 200))) throw new ApiError(400, 'INVALID_REPORT', 'Provide a bounded report ID, valid state and fills.');
    try {
      for (const fill of body.fills) {
        if (typeof fill.externalFillId !== 'string' || !fill.externalFillId || fill.externalFillId.length > 200 || !/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(fill.currency) || !Number.isSafeInteger(fill.time) || fill.time < 0) throw new Error();
        riskPositive(fill.quantity); riskPositive(fill.price); riskDecimal(fill.fee);
      }
    } catch { throw new ApiError(422, 'INVALID_FILL', 'Fills require positive canonical quantities/prices, signed canonical fees, exact fee currencies and UTC epoch-ms timestamps.'); }
  }
  #signal(eventId: string, body: LiveAction, mode: 'pending' | 'enqueuing' | 'created' = 'pending'): SignalRow {
    const row = this.db.prepare<[string], SignalRow>('SELECT e.alert_id,e.alert_revision,e.payload_json,e.occurred_at,a.revision,a.archived_at,a.definition_json FROM alert_events e JOIN alerts a ON a.id=e.alert_id WHERE e.id=?').get(eventId);
    const payload = row ? JSON.parse(row.payload_json) as { kind?: string } : null;
    const definition = row ? JSON.parse(row.definition_json) as { liveAction?: LiveAction } : null;
    const action = this.db.prepare<[string], ActionRow>('SELECT * FROM alert_live_actions WHERE event_id=?').get(eventId);
    const fixed: LiveAction = { executorId: body.executorId, market: body.market, side: body.side, type: body.type, quantity: body.quantity, ...(body.limitPrice === undefined ? {} : { limitPrice: body.limitPrice }) };
    if (!row || payload?.kind !== 'signal' || row.archived_at !== null || row.alert_revision !== row.revision || !definition?.liveAction || canonical(definition.liveAction) !== canonical(fixed) || (action && canonical(JSON.parse(action.action_json)) !== canonical(fixed))) throw new ApiError(409, 'ALERT_ACTION_INVALIDATED', 'Only a durable fresh signal for the unchanged, nonarchived fixed alert action can create an intent.');
    if (mode !== 'enqueuing' && (!action || action.state !== (mode === 'created' ? 'created' : 'pending') || (mode === 'created' && action.intent_id !== (body as LiveIntent).id))) throw new ApiError(409, 'ALERT_ACTION_INVALIDATED', 'The source event must match its durable live-action queue and created intent.');
    const expiresAt = (body as Partial<OrderIntentRequest>).expiresAt;
    if (expiresAt !== undefined && expiresAt !== row.occurred_at + 60000) throw new ApiError(409, 'ALERT_ACTION_INVALIDATED', 'A signal action cannot change its original event-relative 60-second deadline.');
    if (row.occurred_at > this.clock() || this.clock() >= row.occurred_at + 60000) throw new ApiError(422, 'ALERT_ACTION_STALE', 'The signal live-action deadline has elapsed; no stale retry is allowed.');
    return row;
  }
}
