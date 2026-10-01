export const TIMEFRAMES = ['1', '3', '5', '15', '30', '45', '60', '120', '240', 'D', 'W', 'M'] as const;
export type Timeframe = typeof TIMEFRAMES[number];
export type ProviderId = 'binance' | 'coinbase' | 'csv';
export interface MarketRef { provider: ProviderId; symbol: string }
export interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface BarRange { from?: number; to?: number; limit?: number }
export interface BarGap { from: number; to: number }
export interface BarPage { asOf: number; status: 'live' | 'stale' | 'historical'; bars: Bar[]; nextBefore: number | null; gaps: BarGap[]; providerError?: { code: string; message: string; retryAfter?: number } }
export interface Instrument { market: MarketRef; name: string; baseCurrency: string; quoteCurrency: string; tickSize: string; quantityStep: string; timeframes: string[] }
export interface Quote { market: MarketRef; price: string; observedAt: number; status: 'live' | 'stale' | 'historical'; changePercent: number | null }
export type MarketEvent =
  | { kind: 'update' | 'close'; bar: Bar; receivedAt: number }
  | { kind: 'quote'; quote: Quote }
  | { kind: 'status'; status: 'live' | 'stale'; message: string; receivedAt: number };
/** Public adapter seam; fixtures are supplied only by buildApp, never by production config. */
export interface MarketTransport {
  readonly provider: 'binance' | 'coinbase';
  listMarkets(): Promise<Instrument[]>;
  getBars(symbol: string, timeframe: string, range: BarRange): Promise<Bar[]>;
  getQuote(symbol: string): Promise<Quote>;
  subscribe(symbol: string, timeframe: string, onEvent: (event: MarketEvent) => void): () => void;
  close(): void;
}
export interface DatasetImport { name: string; baseCurrency: string; quoteCurrency: string; timeframe: string; tickSize: string; quantityStep: string }
export interface Dataset extends DatasetImport { id: string; rowCount: number; createdAt: number; sourceHash: string }

export const marketRefSchema = { type: 'object', additionalProperties: false, required: ['provider', 'symbol'], properties: { provider: { type: 'string', enum: ['binance', 'coinbase', 'csv'] }, symbol: { type: 'string', minLength: 1, maxLength: 100 } } } as const;
export const barSchema = { type: 'object', additionalProperties: false, required: ['time', 'open', 'high', 'low', 'close', 'volume'], properties: { time: { type: 'integer', minimum: 0 }, open: { type: 'number', exclusiveMinimum: 0 }, high: { type: 'number', exclusiveMinimum: 0 }, low: { type: 'number', exclusiveMinimum: 0 }, close: { type: 'number', exclusiveMinimum: 0 }, volume: { type: 'number', minimum: 0 } } } as const;
