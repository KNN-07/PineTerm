import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import type { Bar, MarketEvent, Quote } from '../../../../packages/contracts/src/market.js';
import { ApiError } from '../errors.js';

export interface StreamSnapshot { bars: Bar[]; confirmedBefore: number | null; quote?: Quote }
export interface StreamMessage { bar?: Bar; closed?: boolean; quote?: Quote; exchangeTime?: number; tickPrice?: number }
export interface StreamOptions {
  url: string;
  frame?: object;
  duration: number;
  clock: () => number;
  decode: (data: unknown) => StreamMessage | null;
  snapshot: (from: number | undefined, needsQuote: boolean) => Promise<StreamSnapshot>;
  onEvent: (event: MarketEvent) => void;
}

/** Each instance owns exactly one socket; MarketService reference-counts consumers. */
export function subscribeStream(options: StreamOptions) {
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnect: NodeJS.Timeout | null = null;
  let poll: NodeJS.Timeout;
  let watchdog: NodeJS.Timeout;
  let failures = 0;
  let lastMessage = performance.now();
  let lastPrice = -Infinity;
  let lastConfirmed: number | undefined;
  let exchangeTime: number | null = null;
  let current: Bar | null = null;
  let lastTickTime = -Infinity;
  let updateRevision = 0;
  let connectionRevision = 0;
  let rebuilding = true;
  let status: 'live' | 'stale' = 'stale';
  let refreshing = false;
  let refreshAgain = false;
  const buffered: StreamMessage[] = [];

  const emit = (event: MarketEvent) => {
    if (!stopped) options.onEvent(event);
  };
  const setStatus = (next: 'live' | 'stale', message: string, force = false) => {
    if (!force && status === next) return;
    status = next;
    emit({ kind: 'status', status: next, message, receivedAt: options.clock() });
  };
  const confirm = (bar: Bar) => {
    if (lastConfirmed !== undefined && bar.time <= lastConfirmed) return;
    lastConfirmed = bar.time;
    emit({ kind: 'close', bar, receivedAt: options.clock() });
  };
  const apply = (message: StreamMessage) => {
    if (message.quote) {
      if (message.quote.observedAt >= lastPrice) {
        lastPrice = message.quote.observedAt;
        if (message.quote.status === 'live') lastPriceArrival = performance.now();
        else setStatus('stale', 'Exchange price observation is stale.');
        emit({ kind: 'quote', quote: message.quote });
      }
    }
    if (message.bar) {
      if (message.closed) confirm(message.bar);
      else if ((lastConfirmed === undefined || message.bar.time > lastConfirmed) && (!current || message.bar.time >= current.time)) {
        current = message.bar;
        updateRevision++;
        emit({ kind: 'update', bar: current, receivedAt: options.clock() });
      }
    }
    if (message.tickPrice !== undefined && message.exchangeTime !== undefined) {
      const time = Math.floor(message.exchangeTime / options.duration) * options.duration;
      if (current && time === current.time && message.exchangeTime >= lastTickTime && (lastConfirmed === undefined || time > lastConfirmed)) {
        lastTickTime = message.exchangeTime;
        current = { ...current, close: message.tickPrice, high: Math.max(current.high, message.tickPrice), low: Math.min(current.low, message.tickPrice) };
        updateRevision++;
        emit({ kind: 'update', bar: current, receivedAt: options.clock() });
      } else if (!current || time > current.time) {
        void refresh();
      }
    }
  };

  const refresh = async () => {
    if (stopped) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    const observedBeforeRequest = exchangeTime;
    const revisionBeforeRequest = updateRevision;
    const connectionBeforeRequest = connectionRevision;
    try {
      const snapshot = await options.snapshot(lastConfirmed, performance.now() - lastPriceArrival > 15000);
      if (stopped) return;
      if (connectionBeforeRequest !== connectionRevision) {
        refreshAgain = true;
        return;
      }
      const confirmedBefore = Math.max(snapshot.confirmedBefore ?? -Infinity, observedBeforeRequest ?? -Infinity, snapshot.bars.at(-1)?.time ?? -Infinity);
      for (const bar of snapshot.bars) {
        if (bar.time + options.duration <= confirmedBefore) confirm(bar);
        else if (lastConfirmed === undefined || bar.time > lastConfirmed) {
          current = current?.time === bar.time && updateRevision !== revisionBeforeRequest
            ? { ...bar, high: Math.max(bar.high, current.high), low: Math.min(bar.low, current.low), close: current.close }
            : bar;
          emit({ kind: 'update', bar: current, receivedAt: options.clock() });
        }
      }
      if (snapshot.quote) apply({ quote: snapshot.quote });
      rebuilding = false;
      for (const message of buffered.splice(0)) apply(message);
      if (performance.now() - lastMessage <= 15000 && performance.now() - lastPriceArrival <= 30000 && socket?.readyState === WebSocket.OPEN) {
        failures = 0;
        setStatus('live', 'Exchange stream and authoritative history are synchronized.');
      } else if (snapshot.quote?.status === 'live') {
        setStatus('live', 'Live REST observations; exchange socket is rebuilding.');
      }
    } catch (error) {
      const message = error instanceof ApiError ? `${error.code}: ${error.message}` : 'Provider backfill failed.';
      setStatus('stale', message, true);
    } finally {
      refreshing = false;
      if (refreshAgain && !stopped) {
        refreshAgain = false;
        void refresh();
      }
    }
  };

  let lastPriceArrival = -Infinity;
  const scheduleReconnect = () => {
    if (stopped || reconnect) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
    reconnect = setTimeout(() => {
      reconnect = null;
      open();
    }, delay);
    reconnect.unref();
  };
  const open = () => {
    if (stopped) return;
    rebuilding = true;
    connectionRevision++;
    setStatus('stale', 'Connecting exchange stream and backfilling confirmed history.', true);
    const ws = new WebSocket(options.url, { handshakeTimeout: 10000, maxPayload: 1024 * 1024, followRedirects: false });
    socket = ws;
    lastMessage = performance.now();
    ws.on('open', () => {
      if (stopped || socket !== ws) return;
      if (options.frame) ws.send(JSON.stringify(options.frame));
      void refresh();
    });
    ws.on('message', (raw, binary) => {
      if (stopped || socket !== ws) return;
      try {
        if (binary) throw new Error('Unexpected binary exchange frame.');
        const message = options.decode(JSON.parse(raw.toString()));
        if (!message) return;
        lastMessage = performance.now();
        if (message.exchangeTime !== undefined) exchangeTime = Math.max(exchangeTime ?? -Infinity, message.exchangeTime);
        if (message.quote?.status === 'live') lastPriceArrival = performance.now();
        if (rebuilding) {
          if (buffered.length >= 2048) throw new Error('Exchange stream exceeded the backfill buffer.');
          buffered.push(message);
        } else {
          apply(message);
        }
      } catch (error) {
        setStatus('stale', error instanceof ApiError ? `${error.code}: ${error.message}` : 'Exchange stream returned invalid data.', true);
        ws.terminate();
      }
    });
    ws.on('error', () => {
      if (stopped || socket !== ws) return;
      setStatus('stale', 'Exchange WebSocket is unavailable; authoritative REST backfill continues.', true);
      ws.terminate();
    });
    ws.on('close', () => {
      if (stopped || socket !== ws) return;
      socket = null;
      rebuilding = true;
      connectionRevision++;
      buffered.length = 0;
      setStatus('stale', 'Exchange stream disconnected; rebuilding from the last confirmed candle.', true);
      scheduleReconnect();
    });
  };

  // REST remains authoritative for Coinbase closure and repairs a silent/partial socket.
  poll = setInterval(() => void refresh(), 5000);
  poll.unref();
  watchdog = setInterval(() => {
    if (stopped) return;
    if (performance.now() - lastPriceArrival > 30000) setStatus('stale', 'No fresh exchange price observation.');
    if (socket && performance.now() - lastMessage > 15000) {
      setStatus('stale', 'Exchange socket is silent; reconnecting and backfilling.', true);
      socket.terminate();
    }
  }, 5000);
  watchdog.unref();
  open();
  // Initial history is also fetched when the WebSocket handshake itself is blocked.
  void refresh();
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(reconnect ?? undefined);
    clearInterval(poll);
    clearInterval(watchdog);
    buffered.length = 0;
    socket?.terminate();
    socket = null;
  };
}
