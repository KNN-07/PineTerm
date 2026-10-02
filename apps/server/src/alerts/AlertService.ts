import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { AlertCommand, AlertCondition, AlertDefinition, AlertEvent, AlertLeaf, AlertPayload, PineAlertCondition, UpdateAlert } from '../../../../packages/contracts/src/alerts.js';
import type { Bar, MarketEvent } from '../../../../packages/contracts/src/market.js';
import type { PineExecutionResult } from '../../../../packages/contracts/src/pine.js';
import { bucketStart, findGaps, isTimeframe, nextBucket } from '../../../../packages/domain/src/market.js';
import { decimalString, financialDecimal } from '../../../../packages/domain/src/index.js';
import type { AppDatabase } from '../database.js';
import type { InvalidationHub } from '../events.js';
import { ApiError } from '../errors.js';
import type { MarketService } from '../market/MarketService.js';
import type { PineService } from '../pine/PineService.js';
import { PineRunnerError } from '../pine/DockerRunner.js';
import type { ScriptService } from '../scripts/ScriptService.js';
import type { NotificationService } from '../notifications/NotificationService.js';

interface EvaluationState {
  previousPrice: string | null;
  truth: boolean;
  lastBucket: number | null;
  lastObservedAt: number | null;
  recovering: boolean;
}
interface AlertRow {
  id: string; revision: number; definition_json: string; warmup_from: number | null;
  evaluation_watermark: number | null; evaluation_state_json: string; paused_reason: string | null;
  enabled: number; created_at: number; updated_at: number; archived_at: number | null;
}
interface EventRow { payload_json: string; alert_revision: number; created_at: number }
interface Runtime {
  id: string; revision: number; epoch: number; controller: AbortController;
  operation: AbortController | null; stop: () => void; tail: Promise<void>; recovering: boolean;
}
const INITIAL_STATE: EvaluationState = { previousPrice: null, truth: false, lastBucket: null, lastObservedAt: null, recovering: false };
const MAX_BARS = 50_000;
const FRESH_MS = 30_000;
function leaves(condition: AlertCondition): AlertLeaf[] { return condition.kind === 'group' ? condition.conditions : [condition]; }
function hasPine(condition: AlertCondition): boolean { return leaves(condition).some(leaf => leaf.kind === 'pine'); }
function definition(row: AlertRow): AlertDefinition {
  return { ...JSON.parse(row.definition_json) as AlertCommand, id: row.id, revision: row.revision, enabled: row.enabled === 1, warmupFrom: row.warmup_from, watermark: row.evaluation_watermark, pausedReason: row.paused_reason, createdAt: row.created_at, updatedAt: row.updated_at };
}
function aggregate(condition: AlertCondition, values: boolean[]): boolean {
  return condition.kind === 'group' && condition.operator === 'any' ? values.some(Boolean) : values.every(Boolean);
}
function priceTruth(leaf: AlertLeaf, current: Decimal, previous: Decimal | null): boolean {
  if (leaf.kind !== 'price') return false;
  const threshold = financialDecimal(leaf.price);
  switch (leaf.operator) {
    case 'above': return current.gt(threshold);
    case 'below': return current.lt(threshold);
    case 'crosses_above': return previous !== null && previous.lte(threshold) && current.gt(threshold);
    case 'crosses_below': return previous !== null && previous.gte(threshold) && current.lt(threshold);
  }
}
function matches(leaf: PineAlertCondition, event: PineExecutionResult['alerts'][number]): boolean {
  return event.type === leaf.eventType && (leaf.eventType === 'alert' || event.title === leaf.title);
}

/** Server-only live authority: immutable Pine revisions, confirmed raw bars and atomic event/outbox writes. */
export class AlertService {
  readonly #runtimes = new Map<string, Runtime>();
  readonly #tasks = new Set<Promise<void>>();
  #closed = false;
  constructor(private readonly db: AppDatabase, private readonly market: MarketService, private readonly pine: PineService, private readonly scripts: ScriptService, private readonly notifications: NotificationService, private readonly clock: () => number, private readonly events: InvalidationHub) {}

  async initialise(): Promise<void> {
    for (const row of this.db.prepare<[], AlertRow>('SELECT * FROM alerts WHERE enabled=1 AND archived_at IS NULL').all()) this.#start(row, true);
    await this.idle();
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const runtime of this.#runtimes.values()) this.#stop(runtime.id);
    await this.idle();
  }
  /** A barrier for work already queued, including evaluations enqueued by that work, not a timer/poll. */
  async idle(): Promise<void> {
    while (this.#tasks.size) await Promise.all([...this.#tasks]);
  }
  #row(id: string, archived = false): AlertRow {
    const row = this.db.prepare<[string], AlertRow>(`SELECT * FROM alerts WHERE id=?${archived ? '' : ' AND archived_at IS NULL'}`).get(id);
    if (!row) throw new ApiError(404, 'ALERT_NOT_FOUND', 'The alert does not exist. Deleted alerts retain their event history.');
    return row;
  }
  list(): AlertDefinition[] { return this.db.prepare<[], AlertRow>('SELECT * FROM alerts WHERE archived_at IS NULL ORDER BY created_at DESC,id').all().map(definition); }
  get(id: string): AlertDefinition { return definition(this.#row(id)); }
  listEvents(alertId?: string): AlertEvent[] {
    if (alertId) this.#row(alertId, true);
    return this.db.prepare<[string | null, string | null], EventRow>('SELECT payload_json,alert_revision,created_at FROM alert_events WHERE (? IS NULL OR alert_id=?) ORDER BY occurred_at DESC,created_at DESC,id DESC').all(alertId ?? null, alertId ?? null).map(row => {
      const payload = JSON.parse(row.payload_json) as AlertEvent;
      return { ...payload, alertRevision: row.alert_revision, createdAt: row.created_at, deliveries: this.notifications.listDeliveries(payload.eventId) };
    });
  }
  async #validate(body: AlertCommand): Promise<AlertCommand> {
    if (!body.name.trim() || body.name.length > 100) throw new ApiError(400, 'INVALID_NAME', 'Alert names contain 1–100 characters.');
    if (body.market.provider === 'csv') throw new ApiError(422, 'HISTORICAL_ALERT', 'Imported datasets and replay sessions cannot arm live alerts.');
    if (!isTimeframe(body.timeframe)) throw new ApiError(422, 'UNSUPPORTED_TIMEFRAME', 'Select a supported live timeframe.');
    const selected = leaves(body.condition);
    if (!selected.length || selected.length > 20 || selected.some(leaf => leaf.kind !== 'price' && leaf.kind !== 'pine')) throw new ApiError(400, 'INVALID_ALERT_GROUP', 'Use 1–20 flat price/Pine conditions.');
    for (const leaf of selected) {
      if (leaf.kind === 'price' && !financialDecimal(leaf.price).isPositive()) throw new ApiError(400, 'INVALID_ALERT_PRICE', 'Alert prices must be positive decimal strings.');
      if (leaf.kind === 'pine' && leaf.eventType === 'alertcondition' && !leaf.title?.trim()) throw new ApiError(400, 'ALERT_TITLE_REQUIRED', 'Select the exact named alertcondition title.');
      if (leaf.kind === 'pine' && leaf.eventType === 'alert' && leaf.title !== undefined) throw new ApiError(400, 'INVALID_ALERT_TITLE', 'alert() does not have a named title.');
    }
    if (hasPine(body.condition)) {
      if (body.mode !== 'bar-close') throw new ApiError(422, 'PINE_REQUIRES_CONFIRMED_CLOSE', 'Pine and mixed groups evaluate together at confirmed bar close, never on quotes.');
      if (!body.scriptRevisionId) throw new ApiError(400, 'SCRIPT_REVISION_REQUIRED', 'Pine alerts bind one immutable script revision and inputs for all Pine conditions.');
      this.scripts.getRevision(body.scriptRevisionId);
    } else if (body.scriptRevisionId !== undefined || body.inputs !== undefined) throw new ApiError(400, 'UNUSED_PINE_PARAMETERS', 'Price-only alerts cannot carry unused Pine revision/inputs.');
    if (body.warmupFrom !== undefined && (!Number.isSafeInteger(body.warmupFrom) || body.warmupFrom < 0 || body.warmupFrom > this.clock())) throw new ApiError(400, 'INVALID_WARMUP', 'Warm-up starts at a past UTC epoch-millisecond time.');
    this.notifications.validateDestinations(body.destinations);
    const instrument = await this.market.getInstrument(body.market);
    if (!instrument.timeframes.includes(body.timeframe)) throw new ApiError(422, 'UNSUPPORTED_TIMEFRAME', 'The instrument does not support this timeframe.');
    return structuredClone({ ...body, name: body.name.trim(), frequency: body.frequency ?? 'once_per_bar' });
  }
  async create(body: AlertCommand): Promise<AlertDefinition> {
    const command = await this.#validate(body);
    if (this.#closed) throw new ApiError(503, 'ALERT_SERVICE_CLOSED', 'Alerts are shutting down.');
    const id = randomUUID(); const now = this.clock();
    const event = this.db.transaction(() => {
      this.db.prepare('INSERT INTO alerts(id,name,revision,provider,symbol,timeframe,mode,frequency,enabled,script_revision_id,definition_json,warmup_from,evaluation_state_json,created_at,updated_at) VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, command.name, command.market.provider, command.market.symbol, command.timeframe, command.mode, command.frequency, Number(command.enabled), command.scriptRevisionId ?? null, JSON.stringify(command), command.warmupFrom ?? null, JSON.stringify(INITIAL_STATE), now, now);
      return this.events.record('alerts.changed', id, 1);
    }).immediate();
    this.events.emit(event);
    if (command.enabled) { const runtime = this.#start(this.#row(id), false); await runtime.tail; }
    return this.get(id);
  }
  async update(id: string, body: UpdateAlert): Promise<AlertDefinition> {
    const command = await this.#validate(body);
    if (this.#closed) throw new ApiError(503, 'ALERT_SERVICE_CLOSED', 'Alerts are shutting down.');
    const { revision: _revision, ...stored } = command as UpdateAlert;
    const event = this.db.transaction(() => {
      const row = this.#row(id);
      if (row.revision !== body.revision) throw new ApiError(409, 'REVISION_CONFLICT', 'The alert changed. Reload before explicitly re-arming.', { currentRevision: row.revision });
      this.db.prepare('UPDATE alerts SET name=?,revision=revision+1,provider=?,symbol=?,timeframe=?,mode=?,frequency=?,enabled=?,script_revision_id=?,definition_json=?,warmup_from=?,evaluation_watermark=NULL,evaluation_state_json=?,paused_reason=NULL,updated_at=? WHERE id=? AND revision=?').run(stored.name, stored.market.provider, stored.market.symbol, stored.timeframe, stored.mode, stored.frequency, Number(stored.enabled), stored.scriptRevisionId ?? null, JSON.stringify(stored), stored.warmupFrom ?? null, JSON.stringify(INITIAL_STATE), this.clock(), id, body.revision);
      return this.events.record('alerts.changed', id, row.revision + 1);
    }).immediate();
    this.#stop(id); this.events.emit(event);
    if (stored.enabled) { const runtime = this.#start(this.#row(id), false); await runtime.tail; }
    return this.get(id);
  }
  delete(id: string): void {
    const event = this.db.transaction(() => {
      const row = this.#row(id);
      this.db.prepare('UPDATE alerts SET enabled=0,archived_at=?,updated_at=?,revision=revision+1 WHERE id=?').run(this.clock(), this.clock(), id);
      this.db.prepare("UPDATE alert_deliveries SET state='failed',last_error='Alert deleted' WHERE state IN ('pending','sending') AND event_id IN (SELECT id FROM alert_events WHERE alert_id=?)").run(id);
      return this.events.record('alerts.changed', id, row.revision + 1);
    }).immediate();
    this.#stop(id); this.events.emit(event); this.notifications.wake();
  }
  async test(id: string): Promise<AlertEvent> {
    const row = this.#row(id); const alert = definition(row);
    this.notifications.validateDestinations(alert.destinations);
    const now = this.clock(); const eventId = randomUUID();
    const payload: AlertPayload = { eventId, alertId: id, occurredAt: now, market: alert.market, timeframe: alert.timeframe, message: `[TEST — not a signal] ${alert.name}: explicit configured-destination test.`, ...(alert.scriptRevisionId ? { scriptRevisionId: alert.scriptRevisionId } : {}) };
    const event = this.db.transaction(() => {
      this.#insertEvent(row, payload, 'test', `test:${eventId}`, true);
      return this.events.record('alerts.changed', id, row.revision);
    }).immediate();
    this.events.emit(event); this.notifications.wake();
    return this.listEvents(id).find(item => item.eventId === eventId)!;
  }
  #insertEvent(row: AlertRow, payload: AlertPayload & Pick<AlertEvent, 'missed'>, kind: AlertEvent['kind'], key: string, deliver: boolean): boolean {
    const changed = this.db.prepare('INSERT OR IGNORE INTO alert_events(id,alert_id,alert_revision,dedupe_key,payload_json,occurred_at,created_at) VALUES (?,?,?,?,?,?,?)').run(payload.eventId, row.id, row.revision, key, JSON.stringify({ ...payload, kind }), payload.occurredAt, this.clock());
    if (changed.changes && deliver) this.notifications.enqueue(payload.eventId, definition(row).destinations, this.clock());
    return changed.changes === 1;
  }
  #stop(id: string): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    this.#runtimes.delete(id); runtime.controller.abort(); runtime.operation?.abort(); runtime.stop();
  }
  #current(runtime: Runtime, epoch?: number): boolean {
    if (this.#closed || runtime.controller.signal.aborted || this.#runtimes.get(runtime.id) !== runtime || (epoch !== undefined && runtime.epoch !== epoch)) return false;
    const row = this.db.prepare<[string], AlertRow>('SELECT * FROM alerts WHERE id=?').get(runtime.id);
    return row?.revision === runtime.revision && row.enabled === 1 && row.archived_at === null;
  }
  #queue(runtime: Runtime, operation: () => Promise<void>): void {
    const task = runtime.tail.then(async () => {
      if (!this.#current(runtime)) return;
      const epoch = runtime.epoch;
      try { await operation(); }
      catch (error) {
        if (!this.#current(runtime, epoch) || runtime.operation?.signal.aborted) return;
        const transient = error instanceof ApiError && [429, 503].includes(error.statusCode) && !['RUNNER_UNAVAILABLE', 'RUNNER_TIMEOUT'].includes(error.code);
        const reason = error instanceof ApiError ? `${error.code}: ${error.message}` : error instanceof PineRunnerError ? `${error.diagnostic.code}: ${error.diagnostic.message} Explicitly re-arm after correcting the script, runner or history.` : 'ALERT_EVALUATION_FAILED: The isolated evaluation failed. Re-arm after checking script/history and runner availability.';
        this.#pause(runtime, reason, transient);
      }
    });
    runtime.tail = task;
    this.#tasks.add(task); void task.finally(() => this.#tasks.delete(task));
  }
  #start(row: AlertRow, recovering: boolean): Runtime {
    this.#stop(row.id);
    const runtime: Runtime = { id: row.id, revision: row.revision, epoch: 0, controller: new AbortController(), operation: null, stop: () => {}, tail: Promise.resolve(), recovering };
    this.#runtimes.set(row.id, runtime);
    this.#queue(runtime, () => this.#baseline(runtime, recovering ? 'Server restart' : null));
    try { runtime.stop = this.market.subscribeBars(definition(row).market, definition(row).timeframe, event => this.#receive(runtime, event)); }
    catch (error) { this.#pause(runtime, error instanceof ApiError ? `${error.code}: ${error.message}` : 'PROVIDER_UNAVAILABLE: Live subscription failed.', true); }
    return runtime;
  }
  #pause(runtime: Runtime, reason: string, recoverable: boolean): void {
    if (!this.#current(runtime)) return;
    runtime.recovering = true;
    const event = this.db.transaction(() => {
      const row = this.#row(runtime.id); const state = JSON.parse(row.evaluation_state_json) as EvaluationState;
      this.db.prepare('UPDATE alerts SET paused_reason=?,enabled=?,evaluation_state_json=?,updated_at=? WHERE id=? AND revision=?').run(reason, Number(recoverable), JSON.stringify({ ...state, recovering: true }), this.clock(), runtime.id, runtime.revision);
      return this.events.record('alerts.changed', runtime.id, runtime.revision);
    }).immediate();
    this.events.emit(event);
    if (!recoverable) this.#stop(runtime.id);
  }
  #receive(runtime: Runtime, event: MarketEvent): void {
    if (!this.#current(runtime)) return;
    if (event.kind === 'status') {
      if (event.status === 'stale') {
        runtime.recovering = true; runtime.epoch++; runtime.operation?.abort();
        this.#queue(runtime, async () => this.#pause(runtime, `MARKET_UNAVAILABLE: ${event.message}`, true));
      } else this.#queue(runtime, () => this.#baseline(runtime, 'Provider reconnect'));
      return;
    }
    this.#queue(runtime, async () => {
      const row = this.#row(runtime.id); const alert = definition(row);
      if (event.kind === 'quote' && alert.mode === 'quote') {
        if (event.quote.status !== 'live' || this.clock() - event.quote.observedAt > FRESH_MS || event.quote.observedAt > this.clock()) { this.#pause(runtime, 'STALE_QUOTE: Waiting for a fresh provider observation.', true); return; }
        if (runtime.recovering) { await this.#baseline(runtime, 'Quote recovery'); return; }
        await this.#evaluate(runtime, event.quote.price, event.quote.observedAt, null);
      } else if (event.kind === 'close' && alert.mode === 'bar-close') {
        if (runtime.recovering || event.receivedAt - nextBucket(event.bar.time, alert.timeframe) > FRESH_MS || this.clock() - event.receivedAt > FRESH_MS || (row.evaluation_watermark !== null && event.bar.time > nextBucket(row.evaluation_watermark, alert.timeframe))) {
          await this.#baseline(runtime, 'Missed or stale confirmed interval'); return;
        }
        await this.#evaluate(runtime, decimalString(new Decimal(event.bar.close)), event.bar.time, event.bar);
      }
    });
  }
  async #history(alert: AlertDefinition, from: number, to: number, signal: AbortSignal): Promise<Bar[]> {
    let expected = 0;
    for (let time = from; time < to; time = nextBucket(time, alert.timeframe)) {
      if (++expected > MAX_BARS) throw new ApiError(422, 'ALERT_HISTORY_LIMIT', 'The fixed Pine warm-up history reached 50,000 bars. Explicitly re-arm with a later warmupFrom; history is never silently shifted.');
    }
    const pages: Bar[][] = []; let cursor = to; let count = 0;
    while (cursor > from) {
      if (signal.aborted) throw new ApiError(409, 'CANCELLED', 'Alert evaluation was superseded.');
      const page = await this.market.getConfirmedBars(alert.market, alert.timeframe, { from, to: cursor, limit: 5000 });
      if (page.status !== 'live' || page.providerError) throw new ApiError(503, 'MARKET_UNAVAILABLE', 'The selected provider cannot supply fresh confirmed history.');
      count += page.bars.length;
      if (count > MAX_BARS) throw new ApiError(422, 'ALERT_HISTORY_LIMIT', 'The fixed alert history exceeds the 50,000-bar compute budget. Explicitly re-arm with a later warmupFrom.');
      pages.push(page.bars);
      if (page.nextBefore === null || page.nextBefore <= from) break;
      if (page.nextBefore >= cursor) throw new ApiError(503, 'PROVIDER_PAGINATION_FAILED', 'Alert history did not advance.');
      cursor = page.nextBefore;
    }
    const bars = pages.reverse().flat();
    if (findGaps(bars, alert.timeframe, from, to).length || bars.length !== expected) throw new ApiError(422, 'ALERT_DATA_GAPS', 'Fixed alert history has missing confirmed bars. Re-arm only after restoring history or choosing a complete warm-up range.');
    return bars;
  }
  async #run(runtime: Runtime, alert: AlertDefinition, bars: Bar[], to: number): Promise<PineExecutionResult> {
    const revision = this.scripts.getRevision(alert.scriptRevisionId!);
    const symbolInfo = await this.market.getInstrument(alert.market);
    const operation = new AbortController(); runtime.operation = operation;
    try {
      const result = await this.pine.runSnapshot({ type: 'run', jobId: randomUUID(), source: revision.source, inputs: alert.inputs ?? revision.inputs, props: revision.props, market: alert.market, timeframe: alert.timeframe, from: alert.warmupFrom!, to, bars, symbolInfo, alertMode: 'all' }, AbortSignal.any([runtime.controller.signal, operation.signal]));
      if (!result.valid) throw new ApiError(422, 'INVALID_ALERT_SCRIPT', result.diagnostics.map(item => item.message).join('; ') || 'The selected Pine revision is invalid.');
      return result;
    } finally { if (runtime.operation === operation) runtime.operation = null; }
  }
  async #baseline(runtime: Runtime, reason: string | null): Promise<void> {
    const epoch = runtime.epoch; const row = this.#row(runtime.id); let alert = definition(row);
    const oldState = JSON.parse(row.evaluation_state_json) as EvaluationState;
    // Fetch one extra row because the provider page may include a mutable tail.
    const page = await this.market.getConfirmedBars(alert.market, alert.timeframe, { limit: 501 });
    if (page.status !== 'live' || page.providerError) throw new ApiError(503, 'MARKET_UNAVAILABLE', 'Cannot rebuild alert state from unavailable provider history.');
    const confirmed = page.bars.slice(-500);
    const latest = confirmed.at(-1);
    let from = row.warmup_from;
    if (from === null && confirmed.length) from = confirmed[0].time;
    if (from !== null) { from = bucketStart(from, alert.timeframe) === from ? from : nextBucket(from, alert.timeframe); alert = { ...alert, warmupFrom: from }; }
    if (hasPine(alert.condition) && latest && from !== null) {
      const to = nextBucket(latest.time, alert.timeframe);
      const bars = await this.#history(alert, from, to, runtime.controller.signal);
      await this.#run(runtime, alert, bars, to); // Rebuild real Pine var/security state; historical events are deliberately discarded.
    }
    let price: string | null = latest ? decimalString(new Decimal(latest.close)) : null; let observedAt = latest?.time ?? null;
    if (alert.mode === 'quote') {
      const quote = await this.market.getQuote(alert.market);
      if (quote.status !== 'live' || this.clock() - quote.observedAt > FRESH_MS || quote.observedAt > this.clock()) throw new ApiError(503, 'STALE_QUOTE', 'Waiting for a fresh quote to arm the alert baseline.');
      price = quote.price; observedAt = quote.observedAt;
    }
    if (!this.#current(runtime, epoch)) return;
    const truth = price === null ? false : aggregate(alert.condition, leaves(alert.condition).map(leaf => priceTruth(leaf, financialDecimal(price!), null)));
    const state: EvaluationState = { ...oldState, previousPrice: price, truth, lastObservedAt: observedAt, recovering: false };
    const event = this.db.transaction(() => {
      if (reason && row.evaluation_watermark !== null && latest && latest.time > row.evaluation_watermark) {
        let count = 0;
        for (let time = nextBucket(row.evaluation_watermark, alert.timeframe); time <= latest.time; time = nextBucket(time, alert.timeframe)) count++;
        const payload: AlertPayload & Pick<AlertEvent, 'missed'> = { eventId: randomUUID(), alertId: row.id, occurredAt: nextBucket(latest.time, alert.timeframe), market: alert.market, timeframe: alert.timeframe, message: `[MISSED — no delivery] ${reason}: ${count} interval(s). State rebuilt without stale catch-up signals.`, missed: { from: nextBucket(row.evaluation_watermark, alert.timeframe), to: nextBucket(latest.time, alert.timeframe), count, reason }, ...(alert.scriptRevisionId ? { scriptRevisionId: alert.scriptRevisionId } : {}) };
        this.#insertEvent(row, payload, 'missed', `${row.id}:${row.revision}:missed:${row.evaluation_watermark}:${latest.time}`, false);
      }
      this.db.prepare('UPDATE alerts SET warmup_from=?,evaluation_watermark=?,evaluation_state_json=?,paused_reason=NULL,updated_at=? WHERE id=? AND revision=?').run(from, latest?.time ?? row.evaluation_watermark, JSON.stringify(state), this.clock(), runtime.id, runtime.revision);
      return this.events.record('alerts.changed', runtime.id, runtime.revision);
    }).immediate();
    runtime.recovering = false; this.events.emit(event);
  }
  async #evaluate(runtime: Runtime, price: string, time: number, bar: Bar | null): Promise<void> {
    const epoch = runtime.epoch; const row = this.#row(runtime.id); const alert = definition(row);
    const state = JSON.parse(row.evaluation_state_json) as EvaluationState;
    if (bar && row.evaluation_watermark !== null && time <= row.evaluation_watermark) return;
    if (!bar && state.lastObservedAt !== null && time <= state.lastObservedAt) return;
    if (state.previousPrice === null || (hasPine(alert.condition) && alert.warmupFrom === null)) { await this.#baseline(runtime, null); return; }
    const current = financialDecimal(price); const previous = financialDecimal(state.previousPrice);
    let pineEvents: PineExecutionResult['alerts'] = [];
    if (hasPine(alert.condition) && bar) {
      const to = nextBucket(time, alert.timeframe);
      const bars = await this.#history(alert, alert.warmupFrom!, to, runtime.controller.signal);
      const result = await this.#run(runtime, alert, bars, to);
      // Pinned PineTS records the raw bar-open timestamp and absolute index for each real event.
      pineEvents = result.alerts.filter(event => event.time === time && event.bar_index === bars.length - 1);
    }
    if (!this.#current(runtime, epoch)) return;
    const selected = leaves(alert.condition);
    const values = selected.map(leaf => leaf.kind === 'price' ? priceTruth(leaf, current, previous) : pineEvents.some(event => matches(leaf, event)));
    const truth = aggregate(alert.condition, values);
    const bucket = bucketStart(time, alert.timeframe);
    const fire = truth && (bar !== null || !state.truth) && state.lastBucket !== bucket;
    // SDK capture mode 'all' collects occurrences, but the configured alert frequency emits only one per bucket.
    const matchingOrdinal = pineEvents.findIndex(event => selected.some(leaf => leaf.kind === 'pine' && matches(leaf, event)));
    const occurrence = matchingOrdinal < 0 ? null : pineEvents[matchingOrdinal];
    const nextState: EvaluationState = { ...state, previousPrice: price, truth, lastObservedAt: time, lastBucket: fire ? bucket : state.lastBucket, recovering: false };
    let fired = false;
    const invalidation = this.db.transaction(() => {
      if (fire) {
        const payload: AlertPayload = { eventId: randomUUID(), alertId: row.id, occurredAt: bar ? nextBucket(time, alert.timeframe) : time, market: alert.market, timeframe: alert.timeframe, message: occurrence?.message ?? `${alert.name}: ${alert.market.provider.toUpperCase()}:${alert.market.symbol} ${alert.timeframe} ${alert.mode} condition matched at ${price}.`, ...(alert.scriptRevisionId ? { scriptRevisionId: alert.scriptRevisionId } : {}) };
        fired = this.#insertEvent(row, payload, 'signal', `${row.id}:${row.revision}:${alert.market.provider}:${alert.market.symbol}:${alert.timeframe}:${bucket}:${Math.max(0, matchingOrdinal)}`, true);
      }
      this.db.prepare('UPDATE alerts SET evaluation_watermark=?,evaluation_state_json=?,enabled=?,updated_at=? WHERE id=? AND revision=?').run(bar ? time : row.evaluation_watermark, JSON.stringify(nextState), fired && alert.frequency === 'once' ? 0 : 1, this.clock(), row.id, row.revision);
      return this.events.record('alerts.changed', row.id, row.revision);
    }).immediate();
    this.events.emit(invalidation);
    if (fired) { this.notifications.wake(); if (alert.frequency === 'once') this.#stop(runtime.id); }
  }
}
