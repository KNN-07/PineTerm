import type { Bar, BarRange, Instrument, MarketEvent, MarketTransport, Quote } from '../../packages/contracts/src/market.js';

export const FIXTURE_START = Date.UTC(2026, 0, 1);
export const FIXTURE_BARS: Bar[] = [
  [10, 10, 10, 10], [10, 11, 9, 10], [12, 13, 11, 12],
  [13, 14, 12, 13], [14, 15, 13, 14], [15, 16, 14, 15],
].map(([open, high, low, close], index) => ({ time: FIXTURE_START + index * 60000, open, high, low, close, volume: 1 }));

/** Only constructed by test/smoke callers of buildApp; production has no fixture selector. */
export class FixtureTransport implements MarketTransport {
  readonly provider: 'binance' | 'coinbase';
  readonly symbol: string;
  readonly listeners = new Map<string, Set<(event: MarketEvent) => void>>();
  readonly series = new Map<string, Bar[]>([['1', FIXTURE_BARS.map(bar => ({ ...bar }))]]);
  failure: Error | null = null;
  subscriptionStarts = 0;
  quote: Quote;
  constructor(provider: 'binance' | 'coinbase', readonly clock: () => number) {
    this.provider = provider;
    this.symbol = provider === 'binance' ? 'BTCUSDT' : 'BTC-USD';
    this.quote = { market: { provider, symbol: this.symbol }, price: '15', observedAt: clock(), status: 'live', changePercent: null };
  }
  async listMarkets(): Promise<Instrument[]> {
    if (this.failure) throw this.failure;
    return [{ market: { provider: this.provider, symbol: this.symbol }, name: this.symbol, baseCurrency: 'BTC', quoteCurrency: this.provider === 'binance' ? 'USDT' : 'USD', tickSize: '0.01', quantityStep: '1', timeframes: ['1', '5', '15', '60', 'D'] }];
  }
  async getBars(symbol: string, timeframe: string, range: BarRange): Promise<Bar[]> {
    if (this.failure) throw this.failure;
    if (symbol !== this.symbol) throw new Error('Unknown fixture symbol');
    return (this.series.get(timeframe) ?? []).filter(bar => bar.time >= (range.from ?? 0) && bar.time < (range.to ?? Number.MAX_SAFE_INTEGER)).slice(-(range.limit ?? 500)).map(bar => ({ ...bar }));
  }
  async getQuote(symbol: string): Promise<Quote> {
    if (this.failure) throw this.failure;
    if (symbol !== this.symbol) throw new Error('Unknown fixture symbol');
    return { ...this.quote, market: { ...this.quote.market } };
  }
  subscribe(symbol: string, timeframe: string, onEvent: (event: MarketEvent) => void): () => void {
    if (symbol !== this.symbol) throw new Error('Unknown fixture symbol');
    const key = symbol + ':' + timeframe;
    let listeners = this.listeners.get(key);
    if (!listeners) { listeners = new Set(); this.listeners.set(key, listeners); }
    this.subscriptionStarts++;
    listeners.add(onEvent);
    return () => { listeners!.delete(onEvent); if (!listeners!.size) this.listeners.delete(key); };
  }
  emit(timeframe: string, event: MarketEvent): void {
    if (event.kind === 'quote') this.quote = { ...event.quote, market: { ...event.quote.market } };
    for (const listener of this.listeners.get(this.symbol + ':' + timeframe) ?? []) listener(event);
  }
  close(): void { this.listeners.clear(); }
}

export const FIXTURE_CSV = 'time,open,high,low,close,volume\n' + [...FIXTURE_BARS].reverse().map(bar => [new Date(bar.time).toISOString(), bar.open, bar.high, bar.low, bar.close, bar.volume].join(',')).join('\n') + '\n';
