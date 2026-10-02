import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { Bar, BarPage, BarRange, Instrument, InvalidationEvent, MarketRef, Quote, ReplayMarket, ReplayRequest, ReplaySession, ReplaySnapshot } from '@pineterm/contracts';
import { decimalString } from '@pineterm/domain';
import { barIssue, bucketStart, canAggregate, findGaps, fixedDuration, isTimeframe, nextBucket } from '../../../../packages/domain/src/market.js';
import type { AppDatabase } from '../database.js';
import type { InvalidationHub } from '../events.js';
import { ApiError } from '../errors.js';
import type { MarketService } from '../market/MarketService.js';
import type { PaperService } from '../paper/PaperService.js';

interface ReplayRow { id: string; account_id: string; state: ReplaySession['state']; markets_json: string; base_timeframe: string; from_time: number; to_time: number; cursor_time: number; revision: number; created_at: number; updated_at: number }
interface ReplayContext { markets: ReplayMarket[]; series: ReplaySnapshot[] }
const MAX_BARS = 50_000;
const sameMarket = (a: MarketRef, b: MarketRef): boolean => a.provider === b.provider && a.symbol === b.symbol;
const key = (market: MarketRef, timeframe: string): string => `${market.provider}:${market.symbol}:${timeframe}`;

/** A replay owns immutable raw history and an isolated spot account. Its cursor is a close boundary. */
export class ReplayService {
  #closed = false;
  #loads = new Map<string, Promise<ReplaySnapshot>>();
  constructor(private readonly db: AppDatabase, private readonly market: MarketService, private readonly paper: PaperService, private readonly clock: () => number, private readonly events: InvalidationHub) {}

  async initialise(): Promise<void> {
    // A browser clock cannot survive a server restart. Preserve the ledger, never resume future trades.
    for (const row of this.db.prepare<[], { id: string }>("SELECT id FROM replay_sessions WHERE state='active'").all()) this.stop(row.id);
  }

  #row(id: string, active = false): ReplayRow {
    const row = this.db.prepare<[string], ReplayRow>('SELECT * FROM replay_sessions WHERE id=?').get(id);
    if (!row) throw new ApiError(404, 'REPLAY_NOT_FOUND', 'This replay session does not exist.');
    if (active && row.state !== 'active') throw new ApiError(409, 'REPLAY_STOPPED', 'This replay has stopped. Start a new session to rewind.');
    return row;
  }
  #context(row: ReplayRow): ReplayContext {
    const context: ReplayContext = JSON.parse(row.markets_json);
    if (!Array.isArray(context.markets) || !Array.isArray(context.series)) throw new ApiError(409, 'INVALID_REPLAY_SNAPSHOT', 'The stored replay context is incompatible.');
    return context;
  }
  #view(row: ReplayRow): ReplaySession {
    return { id: row.id, accountId: row.account_id, state: row.state, markets: this.#context(row).markets, baseTimeframe: row.base_timeframe, from: row.from_time, to: row.to_time, cursor: row.cursor_time, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  get(id: string): ReplaySession { return this.#view(this.#row(id)); }

  async #snapshot(market: MarketRef, timeframe: string, from: number, to: number, budget: number): Promise<ReplaySnapshot> {
    if (!isTimeframe(timeframe)) throw new ApiError(422, 'UNSUPPORTED_TIMEFRAME', 'Select a supported replay interval.');
    const symbolInfo = structuredClone(await this.market.getInstrument(market));
    if (!symbolInfo.timeframes.includes(timeframe)) throw new ApiError(422, 'UNSUPPORTED_TIMEFRAME', 'The replay instrument does not support this interval.');
    let first = bucketStart(from, timeframe);
    if (first < from) first = nextBucket(first, timeframe);
    const end = bucketStart(to, timeframe);
    let expected = 0;
    for (let time = first; time < end; time = nextBucket(time, timeframe)) {
      if (++expected > budget) throw new ApiError(422, 'REPLAY_BAR_BUDGET', 'The complete replay window exceeds 50,000 frozen bars. Select a shorter window.');
    }
    const pages: Bar[][] = [];
    let before = end;
    let count = 0;
    while (before > first && expected) {
      const page = await this.market.getConfirmedBars(market, timeframe, { from: first, to: before, limit: 5000 });
      if (page.status === 'stale' || page.providerError) throw new ApiError(503, 'MARKET_UNAVAILABLE', 'Confirmed replay history is unavailable at this venue.', page.providerError);
      const bars = page.bars.filter(bar => bar.time >= first && nextBucket(bar.time, timeframe) <= end);
      count += bars.length;
      if (count > budget) throw new ApiError(422, 'REPLAY_BAR_BUDGET', 'The replay exceeds 50,000 frozen bars.');
      pages.push(bars);
      if (page.nextBefore === null) break;
      if (page.nextBefore >= before || page.nextBefore <= first) break;
      before = page.nextBefore;
    }
    const bars = pages.reverse().flat();
    let previous = -1;
    for (const bar of bars) {
      const issue = barIssue(bar);
      if (issue || bar.time <= previous || bucketStart(bar.time, timeframe) !== bar.time) throw new ApiError(422, 'INVALID_REPLAY_HISTORY', issue ?? 'Replay history must be uniquely ordered and interval-aligned.');
      previous = bar.time;
    }
    const gaps = findGaps(bars, timeframe, first, end);
    if (gaps.length || bars.length !== expected) throw new ApiError(422, 'REPLAY_DATA_GAPS', 'Confirmed history does not cover the entire selected replay window. Submit a new range; no missing bars are fabricated.', { market, timeframe, gaps, expectedBars: expected, actualBars: bars.length });
    return { market: { ...market }, timeframe, bars: structuredClone(bars), symbolInfo };
  }

  async create(body: ReplayRequest): Promise<ReplaySession> {
    if (this.#closed) throw new ApiError(503, 'REPLAY_UNAVAILABLE', 'Replay service is shutting down.');
    if (!Number.isSafeInteger(body.from) || !Number.isSafeInteger(body.to) || body.from < 0 || body.to <= body.from || !body.markets.length || body.markets.length > 8) throw new ApiError(400, 'INVALID_REPLAY_RANGE', 'Select one to eight charts and a nonempty UTC replay window.');
    const selected = new Map(body.markets.map(item => [key(item.market, item.timeframe), item]));
    if (selected.size !== body.markets.length) throw new ApiError(400, 'DUPLICATE_REPLAY_SERIES', 'Select each replay market/interval once.');
    if (body.markets.some(item => !isTimeframe(item.timeframe))) throw new ApiError(422, 'UNSUPPORTED_TIMEFRAME', 'Select supported replay intervals.');
    const base = [...body.markets].sort((a, b) => (fixedDuration(a.timeframe) ?? Infinity) - (fixedDuration(b.timeframe) ?? Infinity))[0]!.timeframe;
    if (body.markets.some(item => !canAggregate(base, item.timeframe) || bucketStart(body.from, item.timeframe) !== body.from || bucketStart(body.to, item.timeframe) !== body.to)) throw new ApiError(422, 'REPLAY_CLOCK_ALIGNMENT', 'Start and end must align to every loaded chart interval, and all chart intervals must share the smallest clock. Select a common complete window.');
    if (nextBucket(body.from, base) >= body.to) throw new ApiError(422, 'REPLAY_TOO_SHORT', 'The window must include an initial closed bar and at least one subsequent base bar.');
    const series: ReplaySnapshot[] = [];
    let count = 0;
    for (const item of selected.values()) {
      const snapshot = await this.#snapshot(item.market, item.timeframe, body.from, body.to, MAX_BARS - count);
      count += snapshot.bars.length; series.push(snapshot);
    }
    // Prefer the shared raw base clock when the instrument supports it. Imported coarse datasets keep their own smallest clock.
    for (const item of [...series]) if (item.symbolInfo.timeframes.includes(base) && !series.some(other => sameMarket(other.market, item.market) && other.timeframe === base)) {
      const snapshot = await this.#snapshot(item.market, base, body.from, body.to, MAX_BARS - count);
      count += snapshot.bars.length; series.push(snapshot);
    }
    if (this.#closed) throw new ApiError(503, 'REPLAY_UNAVAILABLE', 'Replay service is shutting down.');
    let event: InvalidationEvent;
    const id = randomUUID();
    this.db.transaction(() => {
      const { account } = this.paper.createReplayAccount({ name: `Replay ${new Date(body.from).toISOString()}`, quoteCurrency: body.quoteCurrency, ...(body.initialBalance === undefined ? {} : { initialBalance: body.initialBalance }), ...(body.commissionBps === undefined ? {} : { commissionBps: body.commissionBps }), ...(body.slippageBps === undefined ? {} : { slippageBps: body.slippageBps }) });
      const now = this.clock();
      this.db.prepare('INSERT INTO replay_sessions(id,account_id,state,markets_json,base_timeframe,from_time,to_time,cursor_time,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, account.id, 'active', JSON.stringify({ markets: body.markets, series }), base, body.from, body.to, nextBucket(body.from, base), 1, now, now);
      event = this.events.record('paper.changed', account.id, account.revision);
    }).immediate();
    this.events.emit(event!);
    return this.get(id);
  }

  step(id: string): ReplaySession {
    let event: InvalidationEvent;
    this.db.transaction(() => {
      const row = this.#row(id, true);
      if (row.cursor_time >= row.to_time) throw new ApiError(409, 'REPLAY_FINISHED', 'The selected replay window is complete. Stop or start a new replay.');
      const boundary = nextBucket(row.cursor_time, row.base_timeframe);
      const context = this.#context(row);
      const markets = new Map(context.markets.map(item => [key(item.market, ''), item.market]));
      for (const market of markets.values()) {
        const item = context.series.filter(item => sameMarket(item.market, market) && (item.timeframe === row.base_timeframe || context.markets.some(selected => sameMarket(selected.market, market) && selected.timeframe === item.timeframe))).sort((a, b) => (fixedDuration(a.timeframe) ?? Infinity) - (fixedDuration(b.timeframe) ?? Infinity))[0]!;
        const bar = item.bars.find(bar => nextBucket(bar.time, item.timeframe) > row.cursor_time && nextBucket(bar.time, item.timeframe) <= boundary);
        if (item.timeframe === row.base_timeframe && !bar) throw new ApiError(409, 'REPLAY_CLOCK_MISMATCH', 'The frozen base history does not contain the next complete bar.');
        if (bar) this.paper.processReplayBar(row.account_id, market, bar, boundary);
      }
      this.db.prepare('UPDATE replay_sessions SET cursor_time=?,revision=revision+1,updated_at=? WHERE id=?').run(boundary, this.clock(), id);
      const account = this.db.prepare<[string], { revision: number }>('SELECT revision FROM paper_accounts WHERE id=?').get(row.account_id)!;
      event = this.events.record('paper.changed', row.account_id, account.revision);
    }).immediate();
    this.events.emit(event!);
    return this.get(id);
  }

  stop(id: string): ReplaySession {
    const existing = this.#row(id);
    if (existing.state === 'stopped') return this.#view(existing);
    let event: InvalidationEvent;
    this.db.transaction(() => {
      const row = this.#row(id);
      for (const order of this.paper.listOrders(row.account_id)) if (order.state === 'open') this.paper.cancelOrder(order.id);
      const now = this.clock();
      this.db.prepare("UPDATE replay_sessions SET state='stopped',revision=revision+1,updated_at=? WHERE id=?").run(now, id);
      this.db.prepare('UPDATE paper_accounts SET archived_at=?,revision=revision+1,updated_at=? WHERE id=?').run(now, now, row.account_id);
      const account = this.db.prepare<[string], { revision: number }>('SELECT revision FROM paper_accounts WHERE id=?').get(row.account_id)!;
      event = this.events.record('paper.changed', row.account_id, account.revision);
    }).immediate();
    this.events.emit(event!);
    return this.get(id);
  }

  async getBars(id: string, market: MarketRef, timeframe: string, range: BarRange = {}): Promise<BarPage> {
    let row = this.#row(id, true);
    let series = this.#context(row).series;
    let snapshot = series.find(item => sameMarket(item.market, market) && item.timeframe === timeframe);
    if (!snapshot) {
      if (!series.some(item => item.market.provider === market.provider)) throw new ApiError(422, 'REPLAY_PROVIDER_MISMATCH', 'Replay secondary data cannot switch to an unselected venue.');
      const context = this.#context(row);
      const secondaryCount = series.filter(item => !context.markets.some(selected => sameMarket(selected.market, item.market) && (selected.timeframe === item.timeframe || item.timeframe === row.base_timeframe))).length;
      if (secondaryCount >= 20) throw new ApiError(422, 'REPLAY_SERIES_BUDGET', 'Replay supports at most 20 secondary series beyond chart and execution history.');
      const loadKey = `${id}:${key(market, timeframe)}`;
      let load = this.#loads.get(loadKey);
      if (!load) {
        load = this.#snapshot(market, timeframe, row.from_time, row.to_time, MAX_BARS - series.reduce((sum, item) => sum + item.bars.length, 0));
        this.#loads.set(loadKey, load);
        void load.finally(() => this.#loads.delete(loadKey)).catch(() => {});
      }
      const loaded = await load;
      this.db.transaction(() => {
        row = this.#row(id, true); series = this.#context(row).series;
        snapshot = series.find(item => sameMarket(item.market, market) && item.timeframe === timeframe);
        if (snapshot) return;
        const context = this.#context(row);
        const secondaryCount = series.filter(item => !context.markets.some(selected => sameMarket(selected.market, item.market) && (selected.timeframe === item.timeframe || item.timeframe === row.base_timeframe))).length;
        if (secondaryCount >= 20 || series.reduce((sum, item) => sum + item.bars.length, loaded.bars.length) > MAX_BARS) throw new ApiError(422, 'REPLAY_BAR_BUDGET', 'Replay secondary data exceeds its frozen history budget.');
        snapshot = loaded; series.push(loaded);
        this.db.prepare('UPDATE replay_sessions SET markets_json=? WHERE id=?').run(JSON.stringify({ markets: this.#context(row).markets, series }), id);
      }).immediate();
    }
    row = this.#row(id, true);
    const limit = range.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000 || (range.from !== undefined && (!Number.isSafeInteger(range.from) || range.from < 0)) || (range.to !== undefined && (!Number.isSafeInteger(range.to) || range.to < 0))) throw new ApiError(400, 'INVALID_BAR_RANGE', 'Use valid UTC boundaries and a limit from 1 to 5000.');
    const closeCursor = Math.min(row.cursor_time, range.to ?? row.cursor_time);
    const eligible = snapshot!.bars.filter(bar => bar.time >= (range.from ?? 0) && bar.time < (range.to ?? Infinity) && nextBucket(bar.time, timeframe) <= closeCursor);
    const bars = eligible.slice(-limit);
    return { asOf: row.cursor_time, status: 'historical', bars: structuredClone(bars), nextBefore: eligible.length > bars.length ? bars[0]!.time : null, gaps: [] };
  }
  getInstrument(id: string, market: MarketRef, timeframe: string): Instrument {
    const row = this.#row(id, true);
    const snapshot = this.#context(row).series.find(item => sameMarket(item.market, market) && item.timeframe === timeframe);
    if (!snapshot) throw new ApiError(404, 'REPLAY_MARKET_NOT_FOUND', 'The requested frozen series metadata is not loaded in this replay.');
    return structuredClone(snapshot.symbolInfo);
  }

  getQuote(id: string, market: MarketRef): Quote {
    const row = this.#row(id, true);
    const series = this.#context(row).series.filter(item => sameMarket(item.market, market)).sort((a, b) => (fixedDuration(a.timeframe) ?? Infinity) - (fixedDuration(b.timeframe) ?? Infinity));
    if (!series.length) throw new ApiError(404, 'REPLAY_MARKET_NOT_FOUND', 'This market is not frozen in the replay session.');
    for (const item of series) {
      const bar = item.bars.findLast(bar => nextBucket(bar.time, item.timeframe) <= row.cursor_time);
      if (bar) return { market: { ...market }, price: decimalString(new Decimal(bar.close)), observedAt: nextBucket(bar.time, item.timeframe), status: 'historical', changePercent: null };
    }
    throw new ApiError(409, 'REPLAY_NO_REFERENCE', 'No completed replay bar is available for this market at the acknowledged cursor.');
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#loads.values());
    for (const row of this.db.prepare<[], { id: string }>("SELECT id FROM replay_sessions WHERE state='active'").all()) this.stop(row.id);
  }
}
