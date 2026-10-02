import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database.js';
import type { MarketService } from '../market/MarketService.js';
import type { InvalidationHub } from '../events.js';
import { ApiError } from '../errors.js';
import { bucketStart, nextBucket, findGaps, isTimeframe, barIssue } from '../../../../packages/domain/src/market.js';
import type { Bar, BarPage, BarRange, Instrument, MarketRef } from '../../../../packages/contracts/src/market.js';
import type { BacktestJob, BacktestRequest, PineDataRequest, PineExecutionResult, PineRunRequest, PineValidateRequest, PineValidation, PineValue, PineDiagnostic } from '../../../../packages/contracts/src/pine.js';
import { PineRunnerError, runnerAvailable, runDocker, RUNNER_IMAGE, type RunnerOutcome, type DataBroker } from './DockerRunner.js';

export interface PineSnapshotPage extends BarPage { symbolInfo: Instrument }
export type PineSnapshotSource = (market: MarketRef, timeframe: string, range: BarRange, signal?: AbortSignal) => Promise<PineSnapshotPage>;
interface RevisionRow { id: string; source: string; source_hash: string }
interface JobRow { id: string; state: BacktestJob['state']; request_json: string; diagnostic_json: string | null; created_at: number; started_at: number | null; completed_at: number | null; result_json?: string | null; provenance_json?: string | null }
interface Snapshot { market: MarketRef; timeframe: string; from: number; to: number; bars: Bar[]; symbolInfo: Instrument; hash: string }
interface SlotWaiter { deferred: PromiseWithResolvers<void>; signal: AbortSignal; abort: () => void }
const MAX_BARS = 50_000;
const MAX_PENDING = 100;

/** JSON hashes sort object keys recursively; bar order and all metadata/parameters remain significant. */
export function pineHash(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return createHash('sha256').update(json).digest('hex');
}

export class PineService {
  readonly #db: AppDatabase;
  readonly #market: MarketService;
  readonly #clock: () => number;
  readonly #events: InvalidationHub;
  readonly #jobs = new Map<string, AbortController>();
  readonly #operations = new Set<AbortController>();
  readonly #waiters: SlotWaiter[] = [];
  readonly #tasks = new Set<Promise<void>>();
  readonly #jobTasks = new Map<string, Promise<void>>();
  #active = 0;
  #closed = false;

  constructor(db: AppDatabase, market: MarketService, clock: () => number, events: InvalidationHub) {
    this.#db = db; this.#market = market; this.#clock = clock; this.#events = events;
  }

  async initialise(): Promise<void> {
    const interrupted = this.#db.prepare<[], { id: string }>("SELECT id FROM backtest_jobs WHERE state IN ('queued','running')").all();
    for (const { id } of interrupted) this.#transition(id, 'failed', { code: 'SERVER_RESTARTED', message: 'The server restarted before execution completed. Submit a new backtest; no interrupted job is treated as successful.' });
  }

  async #acquire(signal: AbortSignal): Promise<void> {
    if (this.#closed || signal.aborted) throw new PineRunnerError({ code: 'CANCELLED', message: 'Pine execution was cancelled.' });
    if (this.#active < 2) { this.#active++; return; }
    if (this.#waiters.length >= MAX_PENDING) throw new ApiError(429, 'PINE_QUEUE_FULL', 'The Pine execution queue is full. Wait for existing jobs to complete.');
    const deferred = Promise.withResolvers<void>();
    const waiter: SlotWaiter = { deferred, signal, abort: () => {
      const index = this.#waiters.indexOf(waiter);
      if (index !== -1) this.#waiters.splice(index, 1);
      deferred.reject(new PineRunnerError({ code: 'CANCELLED', message: 'Queued Pine execution was cancelled.' }));
    } };
    this.#waiters.push(waiter);
    signal.addEventListener('abort', waiter.abort, { once: true });
    await deferred.promise;
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) { next.signal.removeEventListener('abort', next.abort); next.deferred.resolve(); }
    else this.#active--;
  }

  async #execute(request: PineRunRequest | PineValidateRequest, broker: DataBroker | undefined, signal?: AbortSignal, onStart?: () => void): Promise<RunnerOutcome> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.#operations.add(controller);
    let acquired = false;
    try {
      await this.#acquire(controller.signal); acquired = true;
      if (controller.signal.aborted || this.#closed) throw new PineRunnerError({ code: 'CANCELLED', message: 'Pine execution was cancelled.' });
      await runnerAvailable(controller.signal);
      onStart?.();
      return await runDocker(request, broker, controller.signal);
    } finally {
      if (acquired) this.#release();
      this.#operations.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }

  async validate(source: string, inputs: Record<string, PineValue> = {}, props: Record<string, PineValue> = {}, signal?: AbortSignal): Promise<PineValidation> {
    try { return (await this.#execute({ type: 'validate', jobId: randomUUID(), source, inputs, props }, undefined, signal)).validation; }
    catch (error) {
      if (!(error instanceof PineRunnerError) || error.diagnostic.code === 'CANCELLED') throw error;
      if (error.diagnostic.code === 'INVALID_RUNNER_PROTOCOL') throw new ApiError(503, 'RUNNER_UNAVAILABLE', 'The runner protocol is incompatible or unavailable. Rebuild the pinned Docker image.');
      return { valid: false, declarationType: null, inputs: [], props: [], diagnostics: [error.diagnostic] };
    }
  }

  async #snapshot(market: MarketRef, timeframe: string, from: number, to: number, budget: number, primary: boolean, signal?: AbortSignal, source?: PineSnapshotSource): Promise<Snapshot> {
    if (!isTimeframe(timeframe)) throw new ApiError(422, 'UNSUPPORTED_TIMEFRAME', 'Select a supported timeframe.');
    const firstPage = source ? await source(market, timeframe, { from, to, limit: 5000 }, signal) : undefined;
    const symbolInfo = structuredClone(firstPage ? firstPage.symbolInfo : await this.#market.getInstrument(market));
    if (symbolInfo.market.provider !== market.provider || symbolInfo.market.symbol !== market.symbol) throw new ApiError(422, 'INVALID_SNAPSHOT_METADATA', 'Frozen metadata must match its selected market.');
    if (!symbolInfo.timeframes.includes(timeframe)) throw new ApiError(422, 'UNSUPPORTED_TIMEFRAME', 'The selected instrument does not support this timeframe.');
    let first = bucketStart(from, timeframe);
    if (first < from) first = nextBucket(first, timeframe);
    const end = bucketStart(to, timeframe);
    let count = 0;
    for (let time = first; time < end; time = nextBucket(time, timeframe)) {
      if (++count > budget) throw new ApiError(422, 'BAR_BUDGET_EXCEEDED', 'The complete requested range exceeds the 50,000-bar job budget. Submit a shorter range.');
    }
    if (primary && !count) throw new ApiError(422, 'NO_CONFIRMED_BARS', 'The selected range contains no completed bars.');
    const pages: Bar[][] = [];
    let cursor = to;
    let total = 0;
    let loadedFirst = false;
    while (cursor > from && count) {
      if (signal?.aborted) throw new PineRunnerError({ code: 'CANCELLED', message: 'Snapshot loading was cancelled.' });
      const page = firstPage && !loadedFirst ? firstPage : source ? await source(market, timeframe, { from, to: cursor, limit: 5000 }, signal) : await this.#market.getConfirmedBars(market, timeframe, { from, to: cursor, limit: 5000 });
      loadedFirst = true;
      if (page.providerError || page.status === 'stale') throw new ApiError(503, 'MARKET_UNAVAILABLE', 'Confirmed market history is unavailable at the selected provider.', page.providerError);
      if (page.gaps.some((gap) => gap.from < end && gap.to > first)) throw new ApiError(422, 'DATA_GAPS', 'The requested range contains missing candles. Select and submit a new complete range.', { gaps: page.gaps });
      const bars = page.bars.filter((bar) => bar.time >= first && nextBucket(bar.time, timeframe) <= end);
      total += bars.length;
      if (total > budget) throw new ApiError(422, 'BAR_BUDGET_EXCEEDED', 'Primary and secondary snapshots exceed 50,000 total bars.');
      pages.push(bars);
      if (page.nextBefore === null) break;
      if (page.nextBefore >= cursor || page.nextBefore <= from) break;
      cursor = page.nextBefore;
    }
    const bars = pages.reverse().flat();
    let previous = -1;
    for (const bar of bars) {
      const issue = barIssue(bar);
      if (issue || bar.time <= previous || bucketStart(bar.time, timeframe) !== bar.time) throw new ApiError(422, 'INVALID_SNAPSHOT', issue ?? 'Confirmed history is not uniquely ordered/aligned.');
      previous = bar.time;
    }
    const gaps = findGaps(bars, timeframe, first, end);
    if (gaps.length || bars.length !== count) throw new ApiError(422, 'DATA_GAPS', 'Confirmed history does not cover the full requested interval. Select and submit a new complete range.', { gaps, expectedBars: count, actualBars: bars.length });
    const snapshot = { market: { ...market }, timeframe, from, to, bars: structuredClone(bars), symbolInfo };
    return { ...snapshot, hash: pineHash(snapshot) };
  }

  #saveSnapshot(jobId: string, snapshot: Snapshot): void {
    this.#db.prepare('INSERT INTO backtest_snapshots(id,job_id,provider,symbol,timeframe,from_time,to_time,bars_json,symbol_info_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), jobId, snapshot.market.provider, snapshot.market.symbol, snapshot.timeframe, snapshot.from, snapshot.to, JSON.stringify(snapshot.bars), JSON.stringify(snapshot.symbolInfo), snapshot.hash, this.#clock());
  }

  #broker(request: PineRunRequest, snapshots: Map<string, Promise<Snapshot>>, signal?: AbortSignal, persistedJobId?: string, source?: PineSnapshotSource): DataBroker {
    let total = request.bars.length;
    return async (data: PineDataRequest) => {
      if (!data.market || data.market.provider !== request.market.provider || typeof data.market.symbol !== 'string' || !data.market.symbol || data.market.symbol.includes(':') || data.market.symbol.includes(';') || data.from !== request.from || data.to !== request.to || data.limit < 1 || data.limit > MAX_BARS || !isTimeframe(data.timeframe)) throw new ApiError(422, 'SECONDARY_REQUEST_FORBIDDEN', 'Secondary series must use the selected provider, valid raw instruments/timeframes and exactly the bounded run horizon.');
      const key = `${data.market.provider}:${data.market.symbol}/${data.timeframe}`;
      let promise = snapshots.get(key);
      if (!promise) {
        if (snapshots.size >= 21) throw new ApiError(422, 'SECONDARY_SERIES_BUDGET', 'At most 20 distinct secondary series are allowed.');
        promise = this.#snapshot(data.market, data.timeframe, request.from, request.to, MAX_BARS - total, false, signal, source).then((snapshot) => {
          if (snapshot.symbolInfo.quoteCurrency !== request.symbolInfo.quoteCurrency) throw new ApiError(422, 'FX_CONVERSION_UNSUPPORTED', 'Secondary data requires unsupported currency conversion.');
          if (total + snapshot.bars.length > MAX_BARS) throw new ApiError(422, 'BAR_BUDGET_EXCEEDED', 'Primary and secondary snapshots exceed 50,000 total bars.');
          total += snapshot.bars.length;
          if (signal?.aborted) throw new PineRunnerError({ code: 'CANCELLED', message: 'Snapshot loading was cancelled.' });
          if (persistedJobId) this.#saveSnapshot(persistedJobId, snapshot);
          return snapshot;
        });
        snapshots.set(key, promise);
      }
      const snapshot = await promise;
      return { type: 'data_response', id: data.id, bars: snapshot.bars, symbolInfo: snapshot.symbolInfo };
    };
  }

  async runSnapshot(request: PineRunRequest, signal?: AbortSignal, source?: PineSnapshotSource): Promise<PineExecutionResult> {
    if (!Number.isSafeInteger(request.from) || !Number.isSafeInteger(request.to) || request.from < 0 || request.from >= request.to || request.bars.length > MAX_BARS || !isTimeframe(request.timeframe) || request.symbolInfo.market.provider !== request.market.provider || request.symbolInfo.market.symbol !== request.market.symbol) throw new ApiError(422, 'INVALID_SNAPSHOT', 'Provide matching instrument metadata and a bounded raw-bar snapshot.');
    const frozen = structuredClone(request);
    const first = bucketStart(request.from, request.timeframe) === request.from ? request.from : nextBucket(request.from, request.timeframe);
    const end = bucketStart(request.to, request.timeframe);
    if (!frozen.bars.length || frozen.bars.some((bar, index) => barIssue(bar) || bar.time < first || nextBucket(bar.time, request.timeframe) > end || (index > 0 && bar.time <= frozen.bars[index - 1].time)) || findGaps(frozen.bars, request.timeframe, first, end).length) throw new ApiError(422, 'DATA_GAPS', 'Primary snapshot must cover the complete confirmed range without gaps or future bars.');
    const primary: Snapshot = { market: frozen.market, timeframe: frozen.timeframe, from: frozen.from, to: frozen.to, bars: frozen.bars, symbolInfo: frozen.symbolInfo, hash: pineHash(frozen.bars) };
    const snapshots = new Map<string, Promise<Snapshot>>([[`${frozen.market.provider}:${frozen.market.symbol}/${frozen.timeframe}`, Promise.resolve(primary)]]);
    const controller = new AbortController();
    const linkedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const outcome = await this.#execute(frozen, this.#broker(frozen, snapshots, linkedSignal, undefined, source), linkedSignal);
      if (!outcome.result) throw new ApiError(503, 'RUNNER_UNAVAILABLE', 'The runner returned no execution result.');
      return outcome.result;
    } finally { controller.abort(); }
  }

  async submit(request: BacktestRequest, signal?: AbortSignal, source?: PineSnapshotSource): Promise<string> {
    if (this.#closed) throw new ApiError(503, 'RUNNER_UNAVAILABLE', 'Pine execution is shutting down.');
    if (!Number.isSafeInteger(request.from) || !Number.isSafeInteger(request.to) || request.from < 0 || request.from >= request.to) throw new ApiError(400, 'INVALID_RANGE', 'from must be earlier than to, using UTC epoch milliseconds.');
    if (!isTimeframe(request.timeframe) || bucketStart(request.from, request.timeframe) !== request.from || bucketStart(request.to, request.timeframe) !== request.to) throw new ApiError(422, 'RANGE_NOT_ALIGNED', 'Select a complete bar-aligned interval; partial boundary candles cannot enter a profit report.');
    if (this.#jobs.size >= MAX_PENDING) throw new ApiError(429, 'PINE_QUEUE_FULL', 'The backtest queue is full.');
    const revision = this.#db.prepare<[string], RevisionRow>('SELECT id,source,source_hash FROM script_revisions WHERE id = ?').get(request.scriptRevisionId);
    if (!revision) throw new ApiError(404, 'SCRIPT_REVISION_NOT_FOUND', 'The immutable script revision does not exist.');
    const validation = await this.validate(revision.source, request.inputs, request.props, signal);
    if (!validation.valid) throw new ApiError(422, 'INVALID_PINE', 'The script or its overrides failed compilation.', { diagnostics: validation.diagnostics });
    if (validation.declarationType !== 'strategy') throw new ApiError(422, 'STRATEGY_REQUIRED', 'Backtests require a strategy() declaration; indicators can be added to charts.');
    const primary = await this.#snapshot(request.market, request.timeframe, request.from, request.to, MAX_BARS, true, signal, source);
    const currency = request.props.currency ?? validation.props.find((prop) => prop.name === 'currency')?.defval;
    if (currency !== primary.symbolInfo.quoteCurrency) throw new ApiError(422, 'FX_CONVERSION_UNSUPPORTED', `Strategy currency ${String(currency)} differs from quote currency ${primary.symbolInfo.quoteCurrency}; FX conversion is not available. PineTS 0.10.0 does not resolve currency.NONE to the instrument quote currency.`);
    const calcBars = request.props.calc_bars_count ?? validation.props.find((prop) => prop.name === 'calc_bars_count')?.defval;
    if (calcBars !== undefined && calcBars !== 0) throw new ApiError(422, 'PARTIAL_HISTORY_UNSUPPORTED', 'Backtests require calc_bars_count=0; silently shortened histories are not permitted.');
    for (const input of validation.inputs.filter((meta) => meta.type === 'symbol')) {
      const value = request.inputs[input.id] ?? (input.varId ? request.inputs[input.varId] : undefined) ?? input.defval;
      const prefix = typeof value === 'string' ? /^([^:]+):/.exec(value)?.[1] : undefined;
      if (prefix && prefix.toLowerCase() !== request.market.provider) throw new ApiError(422, 'CROSS_PROVIDER_REQUEST', 'Symbol inputs must select the same configured provider.');
    }
    if (signal?.aborted) throw new PineRunnerError({ code: 'CANCELLED', message: 'Backtest preflight was cancelled.' });
    if (this.#closed || this.#jobs.size >= MAX_PENDING) throw new ApiError(429, 'PINE_QUEUE_FULL', 'The backtest queue is full or shutting down.');
    const id = randomUUID();
    const frozenRequest = structuredClone(request);
    const event = this.#db.transaction(() => {
      this.#db.prepare("INSERT INTO backtest_jobs(id,script_revision_id,state,request_json,created_at) VALUES (?,?,'queued',?,?)").run(id, revision.id, JSON.stringify(frozenRequest), this.#clock());
      this.#saveSnapshot(id, primary);
      return this.#events.record('jobs.changed', id, 1);
    }).immediate();
    this.#events.emit(event);
    const controller = new AbortController();
    this.#jobs.set(id, controller);
    const abort = () => { this.#transition(id, 'cancelled', { code: 'CANCELLED', message: 'Pine execution was cancelled; no result is reported.' }); controller.abort(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const run: PineRunRequest = { type: 'run', jobId: id, source: revision.source, inputs: frozenRequest.inputs, props: frozenRequest.props, market: frozenRequest.market, timeframe: frozenRequest.timeframe, from: frozenRequest.from, to: frozenRequest.to, bars: primary.bars, symbolInfo: primary.symbolInfo };
    const snapshots = new Map<string, Promise<Snapshot>>([[`${run.market.provider}:${run.market.symbol}/${run.timeframe}`, Promise.resolve(primary)]]);
    const task = this.#execute(run, this.#broker(run, snapshots, controller.signal, id, source), controller.signal, () => this.#transition(id, 'running')).then(async (outcome) => {
      if (controller.signal.aborted || !outcome.result) return;
      const allSnapshots = await Promise.all(snapshots.values());
      const series = allSnapshots.map((snapshot) => ({ market: snapshot.market, timeframe: snapshot.timeframe, from: snapshot.from, to: snapshot.to, barCount: snapshot.bars.length, snapshotHash: snapshot.hash, metadataHash: pineHash(snapshot.symbolInfo) })).sort((a, b) => `${a.market.provider}:${a.market.symbol}/${a.timeframe}`.localeCompare(`${b.market.provider}:${b.market.symbol}/${b.timeframe}`));
      const provenance = { engine: 'PineTS', engineVersion: '0.10.0', runnerImage: RUNNER_IMAGE, sourceHash: revision.source_hash,
        scriptRevisionId: revision.id, rawBars: true, confirmedOnly: true, from: run.from, to: run.to,
        secondaryVenuePolicy: 'run-provider-only', dynamicSecondaryPrefixPreservation: false,
        submittedInputs: run.inputs, submittedProps: run.props, parametersHash: pineHash({ inputs: run.inputs, props: run.props, resolvedConfig: outcome.result.resolvedConfig }),
        resolvedConfigHash: pineHash(outcome.result.resolvedConfig), snapshotHash: pineHash(series), snapshots: series };
      const completed = this.#db.transaction(() => {
        const row = this.#db.prepare<[string], { state: string }>('SELECT state FROM backtest_jobs WHERE id = ?').get(id);
        if (row?.state !== 'running' || controller.signal.aborted) return null;
        this.#db.prepare('INSERT INTO backtest_results(id,job_id,engine_version,source_hash,snapshot_hash,provenance_json,resolved_config_json,result_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), id, '0.10.0', revision.source_hash, provenance.snapshotHash, JSON.stringify(provenance), JSON.stringify(outcome.result!.resolvedConfig), JSON.stringify(outcome.result), this.#clock());
        this.#db.prepare("UPDATE backtest_jobs SET state='succeeded',completed_at=? WHERE id=?").run(this.#clock(), id);
        return this.#events.record('jobs.changed', id, 3);
      }).immediate();
      if (completed) this.#events.emit(completed);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const diagnostic: PineDiagnostic = error instanceof PineRunnerError ? error.diagnostic : error instanceof ApiError ? { code: error.code, message: error.message } : { code: 'PINE_EXECUTION_FAILED', message: 'The isolated Pine execution could not complete.' };
      this.#transition(id, 'failed', diagnostic);
    }).finally(() => { signal?.removeEventListener('abort', abort); controller.abort(); this.#jobs.delete(id); this.#jobTasks.delete(id); this.#tasks.delete(task); });
    this.#tasks.add(task);
    this.#jobTasks.set(id, task);
    return id;
  }

  #transition(id: string, state: BacktestJob['state'], diagnostic: PineDiagnostic | null = null): void {
    const event = this.#db.transaction(() => {
      const current = this.#db.prepare<[string], { state: BacktestJob['state'] }>('SELECT state FROM backtest_jobs WHERE id=?').get(id);
      if (!current || !['queued', 'running'].includes(current.state)) return null;
      this.#db.prepare('UPDATE backtest_jobs SET state=?,diagnostic_json=?,started_at=CASE WHEN ?=\'running\' THEN ? ELSE started_at END,completed_at=CASE WHEN ? IN (\'failed\',\'cancelled\') THEN ? ELSE completed_at END WHERE id=?').run(state, diagnostic ? JSON.stringify(diagnostic) : null, state, this.#clock(), state, this.#clock(), id);
      return this.#events.record('jobs.changed', id, state === 'running' ? 2 : 3);
    }).immediate();
    if (event) this.#events.emit(event);
  }

  get(id: string): BacktestJob {
    const row = this.#db.prepare<[string], JobRow>('SELECT j.*,r.result_json,r.provenance_json FROM backtest_jobs j LEFT JOIN backtest_results r ON r.job_id=j.id WHERE j.id=?').get(id);
    if (!row) throw new ApiError(404, 'BACKTEST_NOT_FOUND', 'The backtest job does not exist.');
    return { id: row.id, state: row.state, request: JSON.parse(row.request_json), createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at,
      diagnostic: row.diagnostic_json ? JSON.parse(row.diagnostic_json) : null, result: row.result_json ? JSON.parse(row.result_json) : null, provenance: row.provenance_json ? JSON.parse(row.provenance_json) : null };
  }

  list(): BacktestJob[] {
    const rows = this.#db.prepare<[], JobRow>('SELECT * FROM backtest_jobs ORDER BY created_at DESC,id DESC LIMIT 100').all();
    return rows.map((row) => ({ id: row.id, state: row.state, request: JSON.parse(row.request_json), createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at, diagnostic: row.diagnostic_json ? JSON.parse(row.diagnostic_json) : null, result: null, provenance: null }));
  }

  async cancel(id: string): Promise<BacktestJob> {
    const job = this.get(id);
    if (job.state === 'queued' || job.state === 'running') {
      this.#transition(id, 'cancelled', { code: 'CANCELLED', message: 'Cancelled by the user; no result is reported.' });
      this.#jobs.get(id)?.abort();
    }
    await this.#jobTasks.get(id);
    return this.get(id);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const [id, controller] of this.#jobs) { this.#transition(id, 'failed', { code: 'SERVER_STOPPED', message: 'The server stopped before execution completed. Submit a new backtest.' }); controller.abort(); }
    for (const controller of this.#operations) controller.abort();
    await Promise.allSettled(this.#tasks);
  }
}
