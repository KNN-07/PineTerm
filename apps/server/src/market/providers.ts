import { Decimal } from 'decimal.js';
import type { Bar, BarRange, Instrument, MarketEvent, MarketTransport, Quote } from '../../../../packages/contracts/src/market.js';
import { ApiError } from '../errors.js';
import { ProviderRequests } from './requests.js';
import { subscribeStream, type StreamMessage, type StreamSnapshot } from './stream.js';

type Provider = 'binance' | 'coinbase';
const NATIVE_TIMEFRAMES = ['1', '5', '15', '60', 'D'];
const DURATIONS: Record<string, number> = { '1': 60000, '5': 300000, '15': 900000, '60': 3600000, D: 86400000 };
const BINANCE_INTERVALS: Record<string, string> = { '1': '1m', '5': '5m', '15': '15m', '60': '1h', D: '1d' };
const BINANCE_REST = 'https://api.binance.com/api/v3';
const COINBASE_REST = 'https://api.exchange.coinbase.com';
const MAX_PAGES = 256;

function invalidData(provider: Provider): never {
  throw new ApiError(503, 'PROVIDER_INVALID_DATA', `${provider}: exchange returned invalid market data.`, { provider });
}
function record(value: unknown, provider: Provider): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidData(provider);
  return value as Record<string, unknown>;
}
function text(value: unknown, provider: Provider): string {
  if (typeof value !== 'string' || value.length === 0) invalidData(provider);
  return value;
}
function finite(value: unknown, provider: Provider): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') invalidData(provider);
  const number = Number(value);
  if (!Number.isFinite(number)) invalidData(provider);
  return number;
}
function timestamp(value: unknown, provider: Provider): number {
  const time = finite(value, provider);
  if (!Number.isSafeInteger(time) || time < 0) invalidData(provider);
  return time;
}
function decimal(value: unknown, provider: Provider): string {
  if (typeof value !== 'string' && typeof value !== 'number') invalidData(provider);
  try {
    const number = new Decimal(value);
    if (!number.isFinite() || !number.isPositive() || number.isZero()) invalidData(provider);
    return number.toFixed();
  } catch {
    invalidData(provider);
  }
}
function bar(row: unknown, provider: Provider, duration: number): Bar {
  if (!Array.isArray(row) || row.length < 6) invalidData(provider);
  const result: Bar = provider === 'binance'
    ? { time: timestamp(row[0], provider), open: finite(row[1], provider), high: finite(row[2], provider), low: finite(row[3], provider), close: finite(row[4], provider), volume: finite(row[5], provider) }
    : { time: timestamp(finite(row[0], provider) * 1000, provider), open: finite(row[3], provider), high: finite(row[2], provider), low: finite(row[1], provider), close: finite(row[4], provider), volume: finite(row[5], provider) };
  if (result.time % duration !== 0 || Math.min(result.open, result.high, result.low, result.close) <= 0 || result.volume < 0 || result.high < Math.max(result.open, result.close, result.low) || result.low > Math.min(result.open, result.close, result.high)) invalidData(provider);
  return result;
}
function sorted(bars: Iterable<Bar>): Bar[] {
  const rows = new Map<number, Bar>();
  for (const row of bars) rows.set(row.time, row);
  return [...rows.values()].sort((a, b) => a.time - b.time);
}
function validate(provider: Provider, symbol: string, timeframe?: string): number {
  const valid = provider === 'binance' ? /^[A-Z0-9]{2,40}$/.test(symbol) : /^[A-Z0-9]+-[A-Z0-9]+$/.test(symbol);
  if (!valid) throw new ApiError(422, 'UNSUPPORTED_MARKET', `${provider}: use an exact spot exchange symbol.`, { provider, symbol });
  if (timeframe === undefined) return 0;
  const duration = Object.hasOwn(DURATIONS, timeframe) ? DURATIONS[timeframe] : undefined;
  if (duration === undefined) throw new ApiError(422, 'UNSUPPORTED_TIMEFRAME', `${provider}: unsupported native timeframe.`, { provider, timeframe, timeframes: NATIVE_TIMEFRAMES });
  return duration;
}
function bounds(range: BarRange, clock: () => number) {
  const from = range.from ?? 0;
  const to = range.to ?? clock();
  const limit = range.limit ?? 500;
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(to) || to < 0 || to > 8640000000000000 || from > to || !Number.isSafeInteger(limit) || limit < 1 || limit > 100000) {
    throw new ApiError(400, 'INVALID_RANGE', 'Use nonnegative epoch-ms boundaries, from <= to, and a limit of 1–100000.');
  }
  return { from, to, limit };
}
function quote(provider: Provider, symbol: string, price: unknown, observedAt: number, changePercent: number | null, clock: () => number): Quote {
  timestamp(observedAt, provider);
  return { market: { provider, symbol }, price: decimal(price, provider), observedAt, status: clock() - observedAt <= 30000 && observedAt <= clock() + 5000 ? 'live' : 'stale', changePercent };
}
function tooManyPages(provider: Provider): never {
  throw new ApiError(503, 'PROVIDER_RANGE_LIMIT', `${provider}: the requested history exceeds the bounded pagination window; narrow the range.`, { provider, maxPages: MAX_PAGES });
}

class BinanceTransport implements MarketTransport {
  readonly provider = 'binance' as const;
  private readonly requests = new ProviderRequests(this.provider, 2, 200);
  private readonly subscriptions = new Set<() => void>();
  private markets: Promise<Instrument[]> | null = null;
  private marketsAt = -Infinity;
  private closed = false;
  constructor(private readonly clock: () => number) {}

  async listMarkets(): Promise<Instrument[]> {
    if (!this.markets || this.clock() - this.marketsAt > 600000) {
      this.marketsAt = this.clock();
      this.markets = this.loadMarkets().catch(error => { this.markets = null; throw error; });
    }
    return this.markets;
  }
  private async loadMarkets(): Promise<Instrument[]> {
    const response = await this.requests.get(new URL(`${BINANCE_REST}/exchangeInfo`));
    const data = record(response.data, this.provider);
    if (!Array.isArray(data.symbols)) invalidData(this.provider);
    const markets: Instrument[] = [];
    for (const value of data.symbols) {
      const row = record(value, this.provider);
      if (row.status !== 'TRADING' || row.isSpotTradingAllowed === false) continue;
      if (!Array.isArray(row.filters)) invalidData(this.provider);
      const filters = row.filters.map(value => record(value, this.provider));
      const price = filters.find(value => value.filterType === 'PRICE_FILTER');
      const size = filters.find(value => value.filterType === 'LOT_SIZE');
      const symbol = text(row.symbol, this.provider);
      const baseCurrency = text(row.baseAsset, this.provider);
      const quoteCurrency = text(row.quoteAsset, this.provider);
      markets.push({ market: { provider: this.provider, symbol }, name: `${baseCurrency} / ${quoteCurrency}`, baseCurrency, quoteCurrency, tickSize: decimal(price?.tickSize, this.provider), quantityStep: decimal(size?.stepSize, this.provider), timeframes: [...NATIVE_TIMEFRAMES] });
    }
    return markets;
  }

  async getBars(symbol: string, timeframe: string, range: BarRange): Promise<Bar[]> {
    return (await this.history(symbol, timeframe, range)).bars;
  }
  private async history(symbol: string, timeframe: string, range: BarRange): Promise<StreamSnapshot> {
    const duration = validate(this.provider, symbol, timeframe);
    const { from, to, limit } = bounds(range, this.clock);
    if (from === to) return { bars: [], confirmedBefore: null };
    const rows = new Map<number, Bar>();
    let cursor = to;
    let confirmedBefore: number | null = null;
    for (let page = 0; cursor > from && rows.size < limit; page++) {
      if (page >= MAX_PAGES) tooManyPages(this.provider);
      const size = Math.min(1000, limit - rows.size);
      const url = new URL(`${BINANCE_REST}/klines`);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('interval', BINANCE_INTERVALS[timeframe]);
      url.searchParams.set('endTime', String(cursor - 1));
      url.searchParams.set('limit', String(size));
      const response = await this.requests.get(url);
      if (!Array.isArray(response.data)) invalidData(this.provider);
      if (page === 0) confirmedBefore = response.observedAt;
      const chunk = sorted(response.data.map(value => bar(value, this.provider, duration)));
      if (chunk.length === 0) break;
      if (chunk.length > size || chunk.at(-1)!.time >= cursor) invalidData(this.provider);
      for (const item of chunk) if (item.time >= from && item.time < to) rows.set(item.time, item);
      const next = chunk[0].time;
      if (next >= cursor) invalidData(this.provider);
      cursor = next;
      if (chunk.length < size) break;
    }
    return { bars: sorted(rows.values()).slice(-limit), confirmedBefore };
  }

  async getQuote(symbol: string): Promise<Quote> {
    validate(this.provider, symbol);
    const url = new URL(`${BINANCE_REST}/ticker/24hr`);
    url.searchParams.set('symbol', symbol);
    const response = await this.requests.get(url);
    const data = record(response.data, this.provider);
    if (data.symbol !== symbol) invalidData(this.provider);
    return quote(this.provider, symbol, data.lastPrice, timestamp(data.closeTime, this.provider), finite(data.priceChangePercent, this.provider), this.clock);
  }

  subscribe(symbol: string, timeframe: string, onEvent: (event: MarketEvent) => void) {
    const duration = validate(this.provider, symbol, timeframe);
    if (this.closed) throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'binance: transport is closed.');
    const stop = subscribeStream({
      url: `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${BINANCE_INTERVALS[timeframe]}`,
      duration, clock: this.clock, onEvent,
      decode: data => {
        const message = record(data, this.provider);
        if (message.e !== 'kline') return null;
        const candle = record(message.k, this.provider);
        if (candle.s !== symbol || candle.i !== BINANCE_INTERVALS[timeframe] || typeof candle.x !== 'boolean') invalidData(this.provider);
        const value = bar([candle.t, candle.o, candle.h, candle.l, candle.c, candle.v], this.provider, duration);
        const time = timestamp(message.E, this.provider);
        return { bar: value, closed: candle.x, quote: quote(this.provider, symbol, candle.c, time, null, this.clock), exchangeTime: time };
      },
      snapshot: async (from, needsQuote) => {
        const snapshot = await this.history(symbol, timeframe, { ...(from === undefined ? { limit: 3 } : { from, limit: 100000 }) });
        if (needsQuote) snapshot.quote = await this.getQuote(symbol);
        return snapshot;
      },
    });
    const unsubscribe = () => { stop(); this.subscriptions.delete(unsubscribe); };
    this.subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.requests.close();
  }
}

class CoinbaseTransport implements MarketTransport {
  readonly provider = 'coinbase' as const;
  private readonly requests = new ProviderRequests(this.provider, 4, 150);
  private readonly subscriptions = new Set<() => void>();
  private markets: Promise<Instrument[]> | null = null;
  private marketsAt = -Infinity;
  private closed = false;
  constructor(private readonly clock: () => number) {}

  async listMarkets(): Promise<Instrument[]> {
    if (!this.markets || this.clock() - this.marketsAt > 600000) {
      this.marketsAt = this.clock();
      this.markets = this.loadMarkets().catch(error => { this.markets = null; throw error; });
    }
    return this.markets;
  }
  private async loadMarkets(): Promise<Instrument[]> {
    const response = await this.requests.get(new URL(`${COINBASE_REST}/products`));
    if (!Array.isArray(response.data)) invalidData(this.provider);
    const markets: Instrument[] = [];
    for (const value of response.data) {
      const row = record(value, this.provider);
      if (row.status !== 'online' || row.trading_disabled === true) continue;
      const symbol = text(row.id, this.provider);
      const baseCurrency = text(row.base_currency, this.provider);
      const quoteCurrency = text(row.quote_currency, this.provider);
      markets.push({ market: { provider: this.provider, symbol }, name: `${baseCurrency} / ${quoteCurrency}`, baseCurrency, quoteCurrency, tickSize: decimal(row.quote_increment, this.provider), quantityStep: decimal(row.base_increment, this.provider), timeframes: [...NATIVE_TIMEFRAMES] });
    }
    return markets;
  }

  async getBars(symbol: string, timeframe: string, range: BarRange): Promise<Bar[]> {
    return (await this.history(symbol, timeframe, range)).bars;
  }
  private async history(symbol: string, timeframe: string, range: BarRange, budget = { remaining: MAX_PAGES }): Promise<StreamSnapshot> {
    const duration = validate(this.provider, symbol, timeframe);
    const { from, to, limit } = bounds(range, this.clock);
    if (from === to) return { bars: [], confirmedBefore: null };
    const rows = new Map<number, Bar>();
    let cursor = to;
    let confirmedBefore: number | null = null;
    for (let page = 0; cursor > from && rows.size < limit; page++) {
      if (--budget.remaining < 0) tooManyPages(this.provider);
      const start = Math.max(Math.floor(from / duration) * duration, Math.ceil(cursor / duration) * duration - 300 * duration, 0);
      const url = new URL(`${COINBASE_REST}/products/${encodeURIComponent(symbol)}/candles`);
      url.searchParams.set('granularity', String(duration / 1000));
      url.searchParams.set('start', new Date(start).toISOString());
      url.searchParams.set('end', new Date(cursor - 1).toISOString());
      const response = await this.requests.get(url);
      if (!Array.isArray(response.data)) invalidData(this.provider);
      if (page === 0) confirmedBefore = response.observedAt;
      const chunk = sorted(response.data.map(value => bar(value, this.provider, duration)));
      if (chunk.length > 300) invalidData(this.provider);
      for (const item of chunk) if (item.time >= from && item.time >= start && item.time < cursor) rows.set(item.time, item);
      if (start >= cursor) invalidData(this.provider);
      cursor = start;
      // An empty intraday window can be a trading gap, not the start of history.
      // Daily exchange candles let an unbounded newest-count query skip empty days.
      if (range.from === undefined && timeframe !== 'D' && chunk.length === 0 && cursor > 0) {
        const older = await this.history(symbol, 'D', { from: 0, to: cursor, limit: 1 }, budget);
        const day = older.bars.at(-1);
        if (!day) break;
        cursor = Math.min(cursor, day.time + DURATIONS.D);
      }
    }
    return { bars: sorted(rows.values()).slice(-limit), confirmedBefore };
  }

  async getQuote(symbol: string): Promise<Quote> {
    validate(this.provider, symbol);
    const response = await this.requests.get(new URL(`${COINBASE_REST}/products/${encodeURIComponent(symbol)}/ticker`));
    const data = record(response.data, this.provider);
    const observedAt = Date.parse(text(data.time, this.provider));
    return quote(this.provider, symbol, data.price, timestamp(observedAt, this.provider), null, this.clock);
  }

  subscribe(symbol: string, timeframe: string, onEvent: (event: MarketEvent) => void) {
    const duration = validate(this.provider, symbol, timeframe);
    if (this.closed) throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'coinbase: transport is closed.');
    const stop = subscribeStream({
      url: 'wss://ws-feed.exchange.coinbase.com',
      frame: { type: 'subscribe', product_ids: [symbol], channels: ['ticker', 'heartbeat'] },
      duration, clock: this.clock, onEvent,
      decode: data => this.decode(data, symbol),
      snapshot: async (from, needsQuote) => {
        const snapshot = await this.history(symbol, timeframe, { ...(from === undefined ? { limit: 3 } : { from, limit: 100000 }) });
        if (needsQuote) snapshot.quote = await this.getQuote(symbol);
        return snapshot;
      },
    });
    const unsubscribe = () => { stop(); this.subscriptions.delete(unsubscribe); };
    this.subscriptions.add(unsubscribe);
    return unsubscribe;
  }
  private decode(data: unknown, symbol: string): StreamMessage | null {
    const message = record(data, this.provider);
    if (message.type === 'error') throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'coinbase: exchange rejected the WebSocket subscription.', { provider: this.provider });
    if (message.type !== 'ticker' && message.type !== 'heartbeat') return null;
    if (message.product_id !== symbol) invalidData(this.provider);
    const time = timestamp(Date.parse(text(message.time, this.provider)), this.provider);
    if (message.type === 'heartbeat') return { exchangeTime: time };
    const currentQuote = quote(this.provider, symbol, message.price, time, null, this.clock);
    return { quote: currentQuote, exchangeTime: time, tickPrice: finite(message.price, this.provider) };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.requests.close();
  }
}

export function createTransports(clock: () => number = Date.now): Record<Provider, MarketTransport> {
  return { binance: new BinanceTransport(clock), coinbase: new CoinbaseTransport(clock) };
}
