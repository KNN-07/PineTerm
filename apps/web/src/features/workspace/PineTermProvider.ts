import type { BarRange, DataProvider, OHLCV, ProviderInfo, SymbolDescriptor, SymbolInfo } from '@luxalgo/vela';
import { barClose } from '@luxalgo/vela/workspace';
import type { BarPage, Instrument, MarketRef, ProviderId, Quote } from '@pineterm/contracts';
import { TIMEFRAMES } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';

export type FeedKind = 'loading' | 'live' | 'historical' | 'empty' | 'stale' | 'unavailable' | 'disconnected';
export interface FeedState { market: MarketRef; timeframe: string; kind: FeedKind; message: string; asOf: number | null; gaps: number }
export interface StreamFrame { type: 'bar' | 'quote' | 'status'; subscriptionId: string; sequence: number; payload: { kind?: string; bar?: OHLCV; receivedAt?: number; status?: string; message?: string; code?: string } | Quote }
interface StreamEntry {
  market: MarketRef; timeframe: string; channel: 'bars' | 'quotes'; listeners: Set<(frame: StreamFrame) => void>;
  socket: WebSocket | null; timer: number | undefined; attempt: number; sequence: number; opened: boolean; controller: AbortController | null;
}
export const qualifiedMarket = (market: MarketRef): string => `${market.provider.toUpperCase()}:${market.symbol}`;
export function parseMarket(symbol: string | undefined): MarketRef | null {
  if (!symbol) return null;
  const colon = symbol.indexOf(':');
  const provider = symbol.slice(0, colon).toLowerCase();
  if (colon < 1 || !['binance', 'coinbase', 'csv'].includes(provider)) return null;
  return { provider: provider as ProviderId, symbol: symbol.slice(colon + 1) };
}
export const feedKey = (market: MarketRef, timeframe: string): string => `${market.provider}:${market.symbol}:${timeframe}`;

export interface ReplayBinding { sessionId: string; cursor: number }

/** Shared browser subscriptions; all candles and quotes originate in PineTerm. */
export class BackendMarketStream {
  private entries = new Map<string, StreamEntry>();
  replay: ReplayBinding | null = null;
  generation = 0;
  setReplay(binding: ReplayBinding | null): void {
    this.replay = binding;
    this.generation++;
    for (const entry of this.entries.values()) entry.controller?.abort();
  }
  constructor(private readonly client: ApiClient, private readonly onSessionError: (error: ApiError) => void) {}
  subscribe(market: MarketRef, timeframe: string, channel: 'bars' | 'quotes', listener: (frame: StreamFrame) => void): () => void {
    const key = `${channel}:${feedKey(market, channel === 'quotes' ? '1' : timeframe)}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { market, timeframe, channel, listeners: new Set(), socket: null, timer: undefined, attempt: 0, sequence: 0, opened: false, controller: null };
      this.entries.set(key, entry);
    }
    entry.listeners.add(listener);
    if (!entry.socket && !entry.timer) this.connect(key, entry);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size) return;
      this.entries.delete(key); window.clearTimeout(entry.timer); entry.controller?.abort(); entry.socket?.close();
    };
  }
  private connect(key: string, entry: StreamEntry): void {
    if (!entry.listeners.size) return;
    const emit = (frame: StreamFrame) => { if (!this.replay) for (const listener of entry.listeners) listener(frame); };
    const status = (state: string, message: string) => emit({ type: 'status', subscriptionId: key, sequence: 0, payload: { status: state, message, receivedAt: Date.now() } });
    const url = new URL('/api/v1/stream', window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    entry.socket = socket;
    let refreshing = false;
    const pending: StreamFrame[] = [];
    socket.onopen = () => {
      if (!entry.listeners.size) { socket.close(); return; }
      entry.attempt = 0; entry.sequence = 0;
      refreshing = entry.opened;
      entry.opened = true;
      socket.send(JSON.stringify({ type: 'subscribe', channel: entry.channel, market: entry.market, ...(entry.channel === 'bars' ? { timeframe: entry.timeframe } : {}) }));
      if (!refreshing) return;
      status('stale', 'Reconnected; refetching authoritative history before resuming.');
      const controller = new AbortController(); entry.controller = controller;
      const query = new URLSearchParams({ provider: entry.market.provider, symbol: entry.market.symbol });
      if (entry.channel === 'bars') { query.set('timeframe', entry.timeframe); query.set('limit', '5000'); }
      const generation = this.generation;
      void this.client.request<BarPage | Quote>(`/${entry.channel === 'bars' ? 'bars' : 'quotes'}?${query}`, { signal: controller.signal }).then((result) => {
        if (controller.signal.aborted || entry.socket !== socket || generation !== this.generation || this.replay) return;
        if ('bars' in result) {
          for (const bar of result.bars) emit({ type: 'bar', subscriptionId: key, sequence: 0, payload: { kind: 'update', bar, receivedAt: result.asOf } });
          status(result.status, result.providerError?.message ?? 'Authoritative history refreshed.');
        } else emit({ type: 'quote', subscriptionId: key, sequence: 0, payload: result });
        refreshing = false;
        for (const frame of pending) emit(frame);
        pending.length = 0;
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) this.onSessionError(error);
        status('stale', errorMessage(error));
        // Do not accept a missed-sequence stream as an authoritative rebuilt history.
        socket.close();
      });
    };
    socket.onmessage = (event) => {
      let frame: StreamFrame;
      try { frame = JSON.parse(String(event.data)) as StreamFrame; } catch { status('error', 'Server sent an unreadable stream frame.'); return; }
      if (frame.subscriptionId !== key) return;
      if (frame.sequence <= entry.sequence) return;
      if (entry.sequence && frame.sequence !== entry.sequence + 1) { status('stale', 'Missed stream messages; reconnecting to refetch history.'); socket.close(); return; }
      entry.sequence = frame.sequence;
      if (refreshing) {
        if (pending.length >= 500) { socket.close(); return; }
        pending.push(frame);
      } else emit(frame);
    };
    socket.onclose = (event) => {
      if (entry.socket !== socket) return;
      entry.socket = null; entry.controller?.abort();
      if (!entry.listeners.size) return;
      if (event.code === 1008) {
        this.onSessionError(new ApiError(403, 'STREAM_FORBIDDEN', 'Market stream authentication expired or was revoked.'));
        status('error', 'Authenticated market stream is forbidden. Sign in again.'); return;
      }
      status('disconnected', 'Feed disconnected. Last observed data is not a fresh executable quote.');
      entry.timer = window.setTimeout(() => { entry.timer = undefined; this.connect(key, entry); }, Math.min(30_000, 1000 * 2 ** entry.attempt++));
    };
    socket.onerror = () => status('disconnected', 'Market stream connection failed; reconnecting.');
  }
  dispose(): void {
    for (const entry of this.entries.values()) { entry.listeners.clear(); window.clearTimeout(entry.timer); entry.controller?.abort(); entry.socket?.close(); }
    this.entries.clear();
  }
}

/** Public Vela DataProvider seam, without direct exchange transports or fail-soft data. */
export class PineTermProvider implements DataProvider {
  private instruments: Instrument[] | null = null;
  private gapCounts: Record<string, number> = {};
  private controllers = new Set<AbortController>();
  private stops = new Set<() => void>();
  private replayTapes = new Map<string, readonly OHLCV[]>();
  constructor(readonly provider: ProviderId, private readonly client: ApiClient, private readonly stream: BackendMarketStream, private readonly onFeed: (state: FeedState) => void, private readonly onSessionError: (error: ApiError) => void) {}
  get replay(): ReplayBinding | null { return this.stream.replay; }
  setReplayTapes(tapes: Array<{ market: MarketRef; timeframe: string; bars: OHLCV[] }>): void {
    this.replayTapes.clear();
    for (const tape of tapes) if (tape.market.provider === this.provider) this.replayTapes.set(feedKey(tape.market, tape.timeframe), tape.bars);
  }
  info(): ProviderInfo {
    return { name: this.provider, displayName: this.provider === 'csv' ? 'Imported CSV · historical' : this.provider === 'binance' ? 'Binance Spot' : 'Coinbase Exchange', supportedTimeframes: TIMEFRAMES, capabilities: { enumerate: true, stream: this.provider !== 'csv', symbolInfo: true } };
  }
  async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
    const market: MarketRef = { provider: this.provider, symbol: ticker };
    const tape = this.replay && this.replayTapes.get(feedKey(market, timeframe));
    if (tape) {
      // Chart-owned copies: the replay controller may mutate its tape. Never use Vela's offline data mode, which synthesizes live ticks.
      this.onFeed({ market, timeframe, kind: 'historical', asOf: this.replay!.cursor, gaps: 0, message: 'Frozen replay tape · chart clock controls visibility' });
      return tape.filter(bar => (range.from === undefined || bar.time >= range.from) && (range.to === undefined || bar.time < range.to)).slice(-(range.limit ?? 500)).map(bar => ({ ...bar }));
    }
    const controller = new AbortController(); this.controllers.add(controller);
    const query = new URLSearchParams({ provider: this.provider, symbol: ticker, timeframe, limit: String(Math.min(range.limit ?? 500, 5000)) });
    const generation = this.stream.generation;
    const replay = this.stream.replay;
    if (replay) {
      query.set('replaySessionId', replay.sessionId);
      query.set('to', String(Math.floor(Math.min(range.to ?? replay.cursor, replay.cursor))));
    }
    if (range.from !== undefined) query.set('from', String(Math.max(0, Math.floor(range.from))));
    if (!replay && range.to !== undefined) query.set('to', String(Math.floor(range.to)));
    try {
      const page = await this.client.request<BarPage>(`/bars?${query}`, { signal: controller.signal });
      if (controller.signal.aborted || generation !== this.stream.generation) throw new DOMException('Market context changed', 'AbortError');
      this.gapCounts[feedKey(market, timeframe)] = page.gaps.length;
      this.onFeed({ market, timeframe, kind: page.bars.length === 0 ? 'empty' : page.status, asOf: page.asOf, gaps: page.gaps.length, message: page.providerError?.message ?? (replay ? 'Replay · frozen completed raw bars at the server cursor' : page.bars.length ? (page.status === 'historical' ? 'Historical data · no live feed' : `${this.provider.toUpperCase()} authoritative candles`) : 'No history in this range. No candles were invented.') });
      return replay ? page.bars.filter(bar => barClose(bar.time, timeframe) <= replay.cursor) : page.bars;
    } catch (error) {
      if (!controller.signal.aborted) {
        this.onFeed({ market, timeframe, kind: 'unavailable', message: errorMessage(error), asOf: null, gaps: 0 });
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) this.onSessionError(error);
      }
      throw error;
    } finally { this.controllers.delete(controller); }
  }
  async listSymbols(): Promise<SymbolDescriptor[]> {
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const { markets } = await this.client.request<{ markets: Instrument[] }>(`/markets?provider=${this.provider}`, { signal: controller.signal });
      this.instruments = markets;
      return markets.map((instrument) => ({ ticker: instrument.market.symbol, description: instrument.name, type: this.provider === 'csv' ? 'historical' : 'crypto', provider: this.provider }));
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) this.onSessionError(error);
      throw error;
    } finally { this.controllers.delete(controller); }
  }
  async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
    if (!this.instruments?.some((item) => item.market.symbol === ticker)) await this.listSymbols();
    const instrument = this.instruments?.find((item) => item.market.symbol === ticker);
    if (!instrument) throw new ApiError(404, 'MARKET_NOT_FOUND', 'The selected instrument is not available from this venue.');
    const tick = Number(instrument.tickSize);
    const precision = instrument.tickSize.includes('.') ? instrument.tickSize.replace(/0+$/, '').split('.')[1]!.length : 0;
    return { ticker, tickerid: qualifiedMarket(instrument.market), description: instrument.name, prefix: this.provider.toUpperCase(), type: 'crypto', basecurrency: instrument.baseCurrency, currency: instrument.quoteCurrency, mintick: tick, minmove: tick * 10 ** precision, pricescale: 10 ** precision, timezone: 'Etc/UTC', session: '24x7', volumetype: 'base' };
  }
  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): () => void {
    if (this.provider === 'csv') return () => {};
    const market = { provider: this.provider, symbol: ticker };
    const stop = this.stream.subscribe(market, timeframe, 'bars', (frame) => {
      if (frame.type === 'bar' && 'bar' in frame.payload && frame.payload.bar) {
        onBar(frame.payload.bar);
        this.onFeed({ market, timeframe, kind: 'live', message: `${this.provider.toUpperCase()} stream · ${frame.payload.kind === 'close' ? 'confirmed close' : 'forming candle'}`, asOf: frame.payload.receivedAt ?? Date.now(), gaps: this.gapCounts[feedKey(market, timeframe)] ?? 0 });
      } else if (frame.type === 'status' && 'message' in frame.payload) {
        const kind: FeedKind = frame.payload.status === 'live' ? 'live' : frame.payload.status === 'disconnected' ? 'disconnected' : frame.payload.status === 'error' ? 'unavailable' : 'stale';
        this.onFeed({ market, timeframe, kind, message: frame.payload.message ?? 'Feed status changed.', asOf: frame.payload.receivedAt ?? null, gaps: this.gapCounts[feedKey(market, timeframe)] ?? 0 });
      }
    });
    const release = () => { stop(); this.stops.delete(release); };
    this.stops.add(release);
    return release;
  }
  dispose(): void { for (const controller of this.controllers) controller.abort(); this.controllers.clear(); for (const stop of this.stops) stop(); this.stops.clear(); }
  resetPending(): void { for (const controller of this.controllers) controller.abort(); this.controllers.clear(); }
}
