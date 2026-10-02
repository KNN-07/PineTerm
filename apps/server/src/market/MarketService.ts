import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type Database from 'better-sqlite3';
import { TIMEFRAMES, type Bar, type BarPage, type BarRange, type Dataset, type DatasetImport, type Instrument, type MarketEvent, type MarketRef, type MarketTransport, type Quote } from '../../../../packages/contracts/src/market.js';
import { decimalString, financialDecimal } from '../../../../packages/domain/src/index.js';
import { aggregateBars, availableTimeframes, barIssue, bucketStart, completeBucket, findGaps, fixedDuration, isTimeframe, nativeTimeframe, nextBucket } from '../../../../packages/domain/src/market.js';
import { ApiError } from '../errors.js';
import { parseDataset } from './datasets.js';

function providerFailure(error: unknown, provider: string): ApiError {
  return error instanceof ApiError ? error : new ApiError(503, 'PROVIDER_UNAVAILABLE', 'The selected market provider is unavailable.', { provider });
}

interface DatasetRow {
  id: string; name: string; base_currency: string; quote_currency: string; timeframe: string;
  tick_size: string; quantity_step: string; row_count: number; created_at: number; source_hash: string;
}
interface Subscription {
  market: MarketRef; timeframe: string; listeners: Map<(event: MarketEvent) => void, number>; closed: Set<number>;
}
interface Feed {
  market: MarketRef; timeframe: string; subscriptions: Set<Subscription>; bars: Map<number, Bar>;
  confirmed: Set<number>; stop: () => void; generation: number; rebuilding: boolean; pending: MarketEvent[];
  status: 'live' | 'stale'; message: string;
}

export class MarketService {
  readonly #db: Database.Database;
  readonly #transports: Readonly<Record<string, MarketTransport>>;
  readonly #clock: () => number;
  readonly #feeds = new Map<string, Feed>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #tails = new Map<string, { bar: Bar; source: 'rest' | 'stream' }>();
  readonly #quotes = new Map<string, Quote>();
  readonly #datasetById;
  readonly #cacheWrite;
  #closed = false;

  constructor(db: Database.Database, transports: Readonly<Record<string, MarketTransport>>, clock: () => number) {
    this.#db = db;
    this.#transports = transports;
    this.#clock = clock;
    this.#datasetById = db.prepare<[string], DatasetRow>('SELECT * FROM datasets WHERE id = ?');
    this.#cacheWrite = db.prepare('INSERT INTO bar_cache(provider,symbol,timeframe,time,open,high,low,close,volume,confirmed_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,symbol,timeframe,time) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,confirmed_at=excluded.confirmed_at');
  }

  #assertMarket(market: MarketRef): void {
    if (this.#closed) throw new ApiError(503, 'MARKET_SERVICE_CLOSED', 'The market service is shutting down.');
    if (!market || typeof market !== 'object' || Object.keys(market).some((key) => key !== 'provider' && key !== 'symbol') || !['binance', 'coinbase', 'csv'].includes(market.provider) || typeof market.symbol !== 'string' || !market.symbol.length || market.symbol.length > 100) {
      throw new ApiError(400, 'INVALID_MARKET', 'Provide an explicit provider and its unqualified symbol.');
    }
    if (market.provider !== 'csv' && !this.#transports[market.provider]) throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'This provider is not available.', { provider: market.provider });
  }

  #dataset(id: string): Dataset {
    const row = this.#datasetById.get(id);
    if (!row) throw new ApiError(404, 'DATASET_NOT_FOUND', 'The historical dataset does not exist.');
    return { id: row.id, name: row.name, baseCurrency: row.base_currency, quoteCurrency: row.quote_currency, timeframe: row.timeframe, tickSize: row.tick_size, quantityStep: row.quantity_step, rowCount: row.row_count, createdAt: row.created_at, sourceHash: row.source_hash };
  }

  #base(market: MarketRef, timeframe: string): string {
    this.#assertMarket(market);
    if (!isTimeframe(timeframe)) throw new ApiError(422, 'UNSUPPORTED_TIMEFRAME', 'Select a supported market timeframe.', { available: TIMEFRAMES });
    if (market.provider !== 'csv') return nativeTimeframe(timeframe);
    const dataset = this.#dataset(market.symbol);
    if (!availableTimeframes(dataset.timeframe).includes(timeframe)) throw new ApiError(422, 'UNSUPPORTED_TIMEFRAME', 'The dataset cannot supply this timeframe.', { available: availableTimeframes(dataset.timeframe) });
    return dataset.timeframe;
  }

  #persist(market: MarketRef, timeframe: string, bars: readonly Bar[]): void {
    if (this.#closed || market.provider === 'csv' || !bars.length) return;
    const now = this.#clock();
    this.#db.transaction(() => {
      for (const bar of bars) this.#cacheWrite.run(market.provider, market.symbol, timeframe, bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume, now);
    }).immediate();
  }

  #cache(market: MarketRef, timeframe: string, from?: number, to?: number, limit = 100_000): Bar[] {
    return this.#db.prepare<[string, string, string, number, number, number], Bar>('SELECT time,open,high,low,close,volume FROM (SELECT time,open,high,low,close,volume FROM bar_cache WHERE provider=? AND symbol=? AND timeframe=? AND time>=? AND time<? ORDER BY time DESC LIMIT ?) ORDER BY time').all(market.provider, market.symbol, timeframe, from ?? 0, to ?? 8_640_000_000_000_001, limit);
  }

  async getBars(market: MarketRef, timeframe: string, range: BarRange = {}): Promise<BarPage> {
    const base = this.#base(market, timeframe);
    if (!range || typeof range !== 'object' || Object.keys(range).some((key) => !['from', 'to', 'limit'].includes(key))) throw new ApiError(400, 'INVALID_RANGE', 'Provide only from, to and limit.');
    const { from, to } = range;
    const limit = range.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000 || [from, to].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000)) || (from !== undefined && to !== undefined && from >= to)) {
      throw new ApiError(400, 'INVALID_RANGE', 'Use a nonempty half-open UTC millisecond range and limit 1–5000.');
    }
    let alignedFrom = from === undefined ? undefined : bucketStart(from, timeframe);
    if (alignedFrom !== undefined && alignedFrom < from!) alignedFrom = nextBucket(alignedFrom, timeframe);
    const alignedTo = to === undefined ? undefined : nextBucket(to - 1, timeframe);
    if ([alignedFrom, alignedTo].some((value) => value !== undefined && !Number.isSafeInteger(value))) throw new ApiError(400, 'INVALID_RANGE', 'The range must fit representable UTC timeframe boundaries.');
    let bars: Bar[];
    let status: BarPage['status'] = market.provider === 'csv' ? 'historical' : 'live';
    let providerError: BarPage['providerError'];
    let asOf = this.#clock();
    if (market.provider === 'csv') {
      bars = this.#db.prepare<[string, number, number], Bar>('SELECT time,open,high,low,close,volume FROM dataset_bars WHERE dataset_id=? AND time>=? AND time<? ORDER BY time').all(market.symbol, alignedFrom ?? 0, alignedTo ?? 8_640_000_000_000_001);
    } else {
      const ratio = timeframe === 'M' ? Math.ceil(31 * 86_400_000 / fixedDuration(base)!) : Math.ceil(fixedDuration(timeframe)! / fixedDuration(base)!);
      const requestLimit = Math.min(100_000, Math.max(limit + 2, (limit + 2) * ratio + 1));
      const native = new Map<number, Bar>();
      let cursor = alignedTo === undefined ? undefined : alignedTo + fixedDuration(base)!;
      try {
        for (let page = 0; page < 40; page++) {
          const fetched = await this.#transports[market.provider].getBars(market.symbol, base, { from: alignedFrom, to: cursor, limit: requestLimit }).catch((error: unknown) => { throw providerFailure(error, market.provider); });
          if (this.#closed) throw new ApiError(503, 'MARKET_SERVICE_CLOSED', 'The market service is shutting down.');
          const latest = fetched.at(-1);
          for (const bar of fetched) {
            const issue = barIssue(bar);
            if (issue || bucketStart(bar.time, base) !== bar.time) throw new ApiError(503, 'INVALID_PROVIDER_DATA', 'The provider returned invalid or misaligned OHLCV.', { provider: market.provider, issue });
            native.set(bar.time, bar);
          }
          // A successor returned by an exchange snapshot confirms its predecessors, never a local timer.
          if (latest) {
            this.#persist(market, base, fetched.filter((bar) => bar.time < latest.time));
            const key = `${market.provider}:${market.symbol}:${base}`;
            const previous = this.#tails.get(key);
            if (!previous || latest.time > previous.bar.time || (latest.time === previous.bar.time && previous.source === 'rest')) this.#tails.set(key, { bar: latest, source: 'rest' });
          }
          const candidate = aggregateBars([...native.values()].sort((a, b) => a.time - b.time), timeframe).filter((bar) => (from === undefined || bar.time >= from) && (to === undefined || bar.time < to));
          if (candidate.length > limit + 1 || fetched.length < requestLimit || !fetched.length || (alignedFrom !== undefined && fetched[0].time <= alignedFrom)) break;
          const earliest = fetched[0].time;
          if (cursor !== undefined && earliest >= cursor) throw new ApiError(503, 'PROVIDER_PAGINATION_FAILED', 'Provider history did not advance.');
          cursor = earliest;
          if (page === 39) throw new ApiError(503, 'PROVIDER_RANGE_TOO_LARGE', 'The requested market history exceeds the bounded fetch capacity.');
        }
        const tail = this.#tails.get(`${market.provider}:${market.symbol}:${base}`)?.bar;
        if (tail && (alignedFrom === undefined || tail.time >= alignedFrom) && (alignedTo === undefined || tail.time < alignedTo)) native.set(tail.time, tail);
        bars = [...native.values()].sort((a, b) => a.time - b.time);
      } catch (error) {
        if (this.#closed || !(error instanceof ApiError) || ![429, 503].includes(error.statusCode)) throw error;
        bars = this.#cache(market, base, alignedFrom, alignedTo, requestLimit);
        if (!bars.length) throw error;
        status = 'stale';
        providerError = { code: error.code, message: error.message, ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }) };
        const last = this.#db.prepare<[string, string, string], { as_of: number }>('SELECT MAX(confirmed_at) AS as_of FROM bar_cache WHERE provider=? AND symbol=? AND timeframe=?').get(market.provider, market.symbol, base);
        asOf = last?.as_of ?? asOf;
      }
    }
    const aggregated = (timeframe === base ? bars : aggregateBars(bars, timeframe)).filter((bar) => (from === undefined || bar.time >= from) && (to === undefined || bar.time < to));
    const hasEarlier = aggregated.length > limit;
    const selected = aggregated.slice(-limit);
    const gapFrom = hasEarlier ? selected[0].time : from === undefined ? (timeframe === base ? undefined : selected[0]?.time) : alignedFrom! < from ? nextBucket(alignedFrom!, timeframe) : alignedFrom;
    const gapTo = to === undefined ? undefined : market.provider === 'csv' ? alignedTo : Math.min(alignedTo!, nextBucket(bars.at(-1)?.time ?? Math.min(to, this.#clock()), base), this.#clock());
    const gapBars = bars.filter((bar) => (gapFrom === undefined || bar.time >= gapFrom) && (gapTo === undefined || bar.time < gapTo));
    const gaps = findGaps(gapBars, base, gapFrom, gapTo);
    if (market.provider !== 'csv' && status !== 'stale') {
      const confirmed = new Set(bars.slice(0, -1).map((bar) => bar.time));
      if (timeframe !== base) {
        const members = new Map<number, Bar[]>();
        for (const bar of bars) {
          const time = bucketStart(bar.time, timeframe);
          const bucket = members.get(time);
          if (bucket) bucket.push(bar);
          else members.set(time, [bar]);
        }
        this.#persist(market, timeframe, selected.filter((bar) => completeBucket(members.get(bar.time)!, base, timeframe, confirmed)));
      }
      this.#recordGaps(market, timeframe, gaps, gapFrom, gapTo);
    }
    return { asOf, status, bars: selected, nextBefore: hasEarlier ? selected[0].time : null, gaps, ...(providerError ? { providerError } : {}) };
  }

  /** Execution snapshots exclude mutable tails; only exchange-confirmed/cache or imported bars qualify. */
  async getConfirmedBars(market: MarketRef, timeframe: string, range: BarRange = {}): Promise<BarPage> {
    const page = await this.getBars(market, timeframe, range);
    if (!page.bars.length) return page;
    const cutoff = range.to ?? this.#clock();
    const confirmed = new Set<number>();
    if (market.provider !== 'csv') {
      const rows = this.#db.prepare<[string, string, string, number, number], { time: number }>(
        'SELECT time FROM bar_cache WHERE provider=? AND symbol=? AND timeframe=? AND time>=? AND time<?',
      ).all(market.provider, market.symbol, timeframe, page.bars[0].time, nextBucket(page.bars.at(-1)!.time, timeframe));
      for (const row of rows) confirmed.add(row.time);
    }
    const bars = page.bars.filter(bar => nextBucket(bar.time, timeframe) <= cutoff && (market.provider === 'csv' || confirmed.has(bar.time)));
    const gaps = bars.length === page.bars.length ? page.gaps : findGaps(bars, timeframe, page.nextBefore === null ? range.from : page.bars[0].time, range.to);
    return { ...page, bars, gaps };
  }

  #recordGaps(market: MarketRef, timeframe: string, gaps: BarPage['gaps'], from?: number, to?: number): void {
    const now = this.#clock();
    this.#db.transaction(() => {
      if (from !== undefined && to !== undefined) this.#db.prepare('UPDATE bar_gaps SET resolved_at=? WHERE provider=? AND symbol=? AND timeframe=? AND resolved_at IS NULL AND from_time>=? AND to_time<=?').run(now, market.provider, market.symbol, timeframe, from, to);
      const insert = this.#db.prepare('INSERT INTO bar_gaps(id,provider,symbol,timeframe,from_time,to_time,detected_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM bar_gaps WHERE provider=? AND symbol=? AND timeframe=? AND from_time=? AND to_time=? AND resolved_at IS NULL)');
      for (const gap of gaps) insert.run(randomUUID(), market.provider, market.symbol, timeframe, gap.from, gap.to, now, market.provider, market.symbol, timeframe, gap.from, gap.to);
    }).immediate();
  }

  listProviders(): { id: string; name: string; status: 'available' | 'unavailable' | 'historical'; timeframes: string[] }[] {
    return [{ id: 'binance', name: 'Binance Spot', status: this.#transports.binance ? 'available' : 'unavailable', timeframes: [...TIMEFRAMES] }, { id: 'coinbase', name: 'Coinbase Exchange', status: this.#transports.coinbase ? 'available' : 'unavailable', timeframes: [...TIMEFRAMES] }, { id: 'csv', name: 'Imported datasets', status: 'historical', timeframes: [...TIMEFRAMES] }];
  }

  async listMarkets(provider: string, q = ''): Promise<Instrument[]> {
    if (!['binance', 'coinbase', 'csv'].includes(provider)) throw new ApiError(400, 'INVALID_PROVIDER', 'Select binance, coinbase or csv.');
    if (typeof q !== 'string' || q.length > 100) throw new ApiError(400, 'INVALID_QUERY', 'Market search must be at most 100 characters.');
    let markets: Instrument[];
    if (provider === 'csv') {
      const rows = this.#db.prepare<[], DatasetRow>('SELECT * FROM datasets ORDER BY created_at DESC,id').all();
      markets = rows.map((row) => ({ market: { provider: 'csv', symbol: row.id }, name: row.name, baseCurrency: row.base_currency, quoteCurrency: row.quote_currency, tickSize: row.tick_size, quantityStep: row.quantity_step, timeframes: availableTimeframes(row.timeframe) }));
    } else {
      if (!this.#transports[provider]) throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'This provider is not available.', { provider });
      markets = (await this.#transports[provider].listMarkets().catch((error: unknown) => { throw providerFailure(error, provider); })).map((instrument) => ({ ...instrument, timeframes: [...TIMEFRAMES] }));
    }
    const query = q.toUpperCase();
    return markets.filter((instrument) => !query || `${instrument.market.symbol} ${instrument.name} ${instrument.baseCurrency} ${instrument.quoteCurrency}`.toUpperCase().includes(query));
  }

  async getInstrument(market: MarketRef): Promise<Instrument> {
    this.#assertMarket(market);
    const instrument = (await this.listMarkets(market.provider)).find((item) => item.market.symbol === market.symbol);
    if (!instrument) throw new ApiError(404, 'MARKET_NOT_FOUND', 'The market does not exist at the selected provider.');
    return { ...instrument, market: { ...instrument.market }, timeframes: [...instrument.timeframes] };
  }

  async getQuote(market: MarketRef): Promise<Quote> {
    this.#assertMarket(market);
    const key = `${market.provider}:${market.symbol}`;
    if (market.provider === 'csv') {
      this.#dataset(market.symbol);
      const last = this.#db.prepare<[string], Bar>('SELECT time,open,high,low,close,volume FROM dataset_bars WHERE dataset_id=? ORDER BY time DESC LIMIT 1').get(market.symbol);
      if (!last) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'The dataset has no historical closing price.');
      return { market, price: decimalString(new Decimal(last.close)), observedAt: last.time, status: 'historical', changePercent: null };
    }
    const cached = this.#quotes.get(key);
    if (cached?.status === 'live' && this.#clock() - cached.observedAt <= 30_000) return cached;
    try {
      const quote = await this.#transports[market.provider].getQuote(market.symbol);
      if (!financialDecimal(quote.price).gt(0) || !Number.isSafeInteger(quote.observedAt) || quote.market.provider !== market.provider || quote.market.symbol !== market.symbol) throw new ApiError(503, 'INVALID_PROVIDER_DATA', 'The provider returned an invalid quote.');
      const observed = { ...quote, status: this.#clock() - quote.observedAt > 30_000 ? 'stale' as const : quote.status };
      this.#quotes.set(key, observed);
      return observed;
    } catch (error) {
      const failure = providerFailure(error, market.provider);
      if (cached && [429, 503].includes(failure.statusCode)) throw new ApiError(failure.statusCode, failure.code, failure.message, { ...(typeof failure.details === 'object' ? failure.details : {}), lastQuote: { ...cached, status: 'stale' } }, failure.retryAfter);
      throw failure;
    }
  }

  importDataset(meta: DatasetImport, csv: string): Dataset {
    if (this.#closed) throw new ApiError(503, 'MARKET_SERVICE_CLOSED', 'The market service is shutting down.');
    const parsed = parseDataset(meta, csv);
    const dataset: Dataset = { ...parsed.meta, id: randomUUID(), rowCount: parsed.bars.length, createdAt: this.#clock(), sourceHash: parsed.sourceHash };
    this.#db.transaction(() => {
      this.#db.prepare('INSERT INTO datasets(id,name,base_currency,quote_currency,timeframe,tick_size,quantity_step,source_hash,row_count,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(dataset.id, dataset.name, dataset.baseCurrency, dataset.quoteCurrency, dataset.timeframe, dataset.tickSize, dataset.quantityStep, dataset.sourceHash, dataset.rowCount, dataset.createdAt);
      const insert = this.#db.prepare('INSERT INTO dataset_bars(dataset_id,time,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?)');
      for (const bar of parsed.bars) insert.run(dataset.id, bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume);
    }).immediate();
    return dataset;
  }

  subscribeBars(market: MarketRef, timeframe: string, onEvent: (event: MarketEvent) => void): () => void {
    const base = this.#base(market, timeframe);
    if (typeof onEvent !== 'function') throw new ApiError(400, 'INVALID_SUBSCRIBER', 'Provide a market event callback.');
    if (market.provider === 'csv') throw new ApiError(422, 'HISTORICAL_FEED', 'Imported datasets are historical and do not offer live subscriptions.');
    const subscriptionKey = `${market.provider}:${market.symbol}:${timeframe}`;
    let subscription = this.#subscriptions.get(subscriptionKey);
    if (!subscription) {
      subscription = { market: { ...market }, timeframe, listeners: new Map(), closed: new Set() };
      this.#subscriptions.set(subscriptionKey, subscription);
    }
    subscription.listeners.set(onEvent, (subscription.listeners.get(onEvent) ?? 0) + 1);
    const feedKey = `${market.provider}:${market.symbol}:${base}`;
    let feed = this.#feeds.get(feedKey);
    if (!feed) {
      const cached = this.#cache(market, base, undefined, undefined, 128);
      feed = { market: { ...market }, timeframe: base, subscriptions: new Set(), bars: new Map(cached.map((bar) => [bar.time, bar])), confirmed: new Set(cached.map((bar) => bar.time)), stop: () => {}, generation: 0, rebuilding: false, pending: [], status: 'stale', message: 'Connecting to the authoritative provider.' };
      this.#feeds.set(feedKey, feed);
      feed.subscriptions.add(subscription);
      const current = feed;
      try {
        current.stop = this.#transports[market.provider].subscribe(market.symbol, base, (event) => this.#receive(current, event));
      } catch (error) {
        this.#feeds.delete(feedKey);
        this.#subscriptions.delete(subscriptionKey);
        throw providerFailure(error, market.provider);
      }
      this.#hydrate(current);
    } else {
      feed.subscriptions.add(subscription);
      onEvent({ kind: 'status', status: feed.status, message: feed.message, receivedAt: this.#clock() });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const references = subscription!.listeners.get(onEvent) ?? 0;
      if (references > 1) subscription!.listeners.set(onEvent, references - 1);
      else subscription!.listeners.delete(onEvent);
      if (!subscription!.listeners.size) {
        this.#subscriptions.delete(subscriptionKey);
        feed!.subscriptions.delete(subscription!);
      }
      if (!feed!.subscriptions.size) {
        feed!.generation++;
        feed!.stop();
        this.#feeds.delete(feedKey);
        if (this.#tails.get(feedKey)?.source === 'stream') this.#tails.delete(feedKey);
      }
    };
  }

  #hydrate(feed: Feed): void {
    if (feed.rebuilding || this.#closed) return;
    feed.rebuilding = true;
    feed.status = 'stale';
    feed.message = 'Rebuilding authoritative history.';
    const generation = ++feed.generation;
    for (const subscription of feed.subscriptions) this.#emit(subscription, { kind: 'status', status: 'stale', message: 'Rebuilding authoritative history.', receivedAt: this.#clock() });
    void this.getBars(feed.market, feed.timeframe, { limit: 128 }).then((page) => {
      if (this.#closed || generation !== feed.generation || !feed.subscriptions.size) return;
      for (const bar of page.bars) feed.bars.set(bar.time, bar);
      for (const bar of this.#cache(feed.market, feed.timeframe, undefined, undefined, 128)) {
        feed.bars.set(bar.time, bar);
        feed.confirmed.add(bar.time);
      }
      feed.rebuilding = false;
      for (const event of feed.pending.splice(0)) this.#receive(feed, event);
      feed.status = page.status === 'stale' ? 'stale' : 'live';
      feed.message = page.providerError?.message ?? 'Authoritative history rebuilt; refetch after reconnect.';
      for (const subscription of feed.subscriptions) this.#emit(subscription, { kind: 'status', status: feed.status, message: feed.message, receivedAt: this.#clock() });
    }).catch((error: unknown) => {
      if (this.#closed || generation !== feed.generation) return;
      feed.rebuilding = false;
      feed.pending.length = 0;
      feed.status = 'stale';
      feed.message = error instanceof ApiError ? error.message : 'Provider history is unavailable.';
      for (const subscription of feed.subscriptions) this.#emit(subscription, { kind: 'status', status: feed.status, message: feed.message, receivedAt: this.#clock() });
    });
  }

  #emit(subscription: Subscription, event: MarketEvent): void {
    for (const listener of subscription.listeners.keys()) listener(event);
  }

  #receive(feed: Feed, event: MarketEvent): void {
    if (this.#closed || !feed.subscriptions.size) return;
    if (event.kind === 'status') {
      feed.status = event.status;
      feed.message = event.message;
      if (event.status === 'stale') {
        const feedKey = `${feed.market.provider}:${feed.market.symbol}:${feed.timeframe}`;
        if (this.#tails.get(feedKey)?.source === 'stream') this.#tails.delete(feedKey);
        if (feed.rebuilding) {
          feed.generation++;
          feed.rebuilding = false;
          feed.pending.length = 0;
        }
        const key = `${feed.market.provider}:${feed.market.symbol}`;
        const quote = this.#quotes.get(key);
        if (quote) this.#quotes.set(key, { ...quote, status: 'stale' });
      }
      for (const subscription of feed.subscriptions) this.#emit(subscription, event);
      if (event.status === 'live') this.#hydrate(feed);
      return;
    }
    if (event.kind === 'quote') {
      const quote = { ...event.quote, status: this.#clock() - event.quote.observedAt > 30_000 ? 'stale' as const : event.quote.status };
      this.#quotes.set(`${feed.market.provider}:${feed.market.symbol}`, quote);
      for (const subscription of feed.subscriptions) this.#emit(subscription, { kind: 'quote', quote });
      return;
    }
    if (feed.rebuilding) {
      if (feed.pending.length >= 2000) {
        feed.pending.length = 0;
        for (const subscription of feed.subscriptions) this.#emit(subscription, { kind: 'status', status: 'stale', message: 'Stream overflow while rebuilding history; refetch required.', receivedAt: this.#clock() });
      } else feed.pending.push(event);
      return;
    }
    const issue = barIssue(event.bar);
    if (issue || bucketStart(event.bar.time, feed.timeframe) !== event.bar.time) {
      for (const subscription of feed.subscriptions) this.#emit(subscription, { kind: 'status', status: 'stale', message: 'Provider returned invalid candle data.', receivedAt: this.#clock() });
      return;
    }
    if (feed.confirmed.has(event.bar.time) && event.kind === 'update') return;
    feed.bars.set(event.bar.time, event.bar);
    const feedKey = `${feed.market.provider}:${feed.market.symbol}:${feed.timeframe}`;
    if (event.kind === 'close') {
      feed.confirmed.add(event.bar.time);
      this.#persist(feed.market, feed.timeframe, [event.bar]);
      if (this.#tails.get(feedKey)?.bar.time === event.bar.time) this.#tails.delete(feedKey);
    } else this.#tails.set(feedKey, { bar: event.bar, source: 'stream' });
    const sorted = [...feed.bars.values()].sort((left, right) => left.time - right.time);
    for (const subscription of feed.subscriptions) {
      const time = bucketStart(event.bar.time, subscription.timeframe);
      const members = sorted.filter((bar) => bucketStart(bar.time, subscription.timeframe) === time);
      const bar = subscription.timeframe === feed.timeframe ? event.bar : aggregateBars(members, subscription.timeframe)[0];
      if (!bar) continue;
      const closed = subscription.timeframe === feed.timeframe ? event.kind === 'close' : completeBucket(members, feed.timeframe, subscription.timeframe, feed.confirmed);
      if (closed) {
        if (subscription.closed.has(time)) continue;
        subscription.closed.add(time);
        this.#persist(feed.market, subscription.timeframe, [bar]);
      }
      this.#emit(subscription, { kind: closed ? 'close' : 'update', bar, receivedAt: event.receivedAt });
    }
    if (feed.bars.size > 128) {
      for (const bar of sorted.slice(0, sorted.length - 128)) {
        feed.bars.delete(bar.time);
        feed.confirmed.delete(bar.time);
      }
      for (const subscription of feed.subscriptions) for (const time of subscription.closed) if (time < sorted.at(-128)!.time) subscription.closed.delete(time);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const feed of this.#feeds.values()) {
      feed.generation++;
      feed.stop();
    }
    this.#feeds.clear();
    this.#subscriptions.clear();
    this.#tails.clear();
    this.#quotes.clear();
    for (const transport of new Set(Object.values(this.#transports))) transport.close();
  }
}
