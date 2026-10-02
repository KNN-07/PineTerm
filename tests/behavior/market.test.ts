import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../apps/server/src/database.js';
import { MarketService } from '../../apps/server/src/market/MarketService.js';
import { ApiError } from '../../apps/server/src/errors.js';
import type { DatasetImport, MarketEvent } from '../../packages/contracts/src/market.js';
import { FIXTURE_BARS, FIXTURE_CSV, FIXTURE_START, FixtureTransport } from '../fixtures/market.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const metadata: DatasetImport = { name: 'Deterministic import', baseCurrency: 'BTC', quoteCurrency: 'USD', timeframe: '1', tickSize: '0.01', quantityStep: '1' };
async function marketService() {
  const directory = await mkdtemp(join(tmpdir(), 'pineterm-market-'));
  let now = FIXTURE_START + 360000;
  const clock = () => now;
  const db = openDatabase(directory, clock);
  const coinbase = new FixtureTransport('coinbase', clock);
  const binance = new FixtureTransport('binance', clock);
  const service = new MarketService(db, { coinbase, binance }, clock);
  cleanups.push(async () => { service.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { db, service, coinbase, binance, advance: (value: number) => { now = value; } };
}

describe('authoritative market history', () => {
  it('sorts imports and preserves half-open newest-page boundaries', async () => {
    const { service } = await marketService();
    const dataset = service.importDataset(metadata, FIXTURE_CSV);
    const market = { provider: 'csv' as const, symbol: dataset.id };
    expect((await service.getBars(market, '1', {})).bars).toEqual(FIXTURE_BARS);
    expect((await service.getBars(market, '1', { from: FIXTURE_START + 60000, to: FIXTURE_START + 240000 })).bars).toEqual(FIXTURE_BARS.slice(1, 4));
    const latest = await service.getBars(market, '1', { limit: 2 });
    expect(latest.bars).toEqual(FIXTURE_BARS.slice(4));
    expect(latest.nextBefore).toBe(FIXTURE_START + 240000);
    const previous = await service.getBars(market, '1', { limit: 2, to: latest.nextBefore! });
    expect(previous.bars).toEqual(FIXTURE_BARS.slice(2, 4));
    expect((await service.getBars(market, '1', { to: FIXTURE_START })).bars).toEqual([]);
  });
  it('rejects whole invalid imports without leaving datasets or bar rows', async () => {
    const { db, service } = await marketService();
    for (const csv of [FIXTURE_CSV + FIXTURE_CSV.split('\n')[1], 'time,open,high,low,close,volume\n1767225600,10,10,10,10,1', 'time,open,high,low,close,volume\n2026-01-01T00:00:00Z,10,9,8,10,1', 'time,open,high,low,close,volume\n']) {
      expect(() => service.importDataset(metadata, csv)).toThrow();
    }
    expect(db.prepare('SELECT count(*) AS count FROM datasets').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM dataset_bars').get()).toEqual({ count: 0 });
  });
  it('aggregates raw values but records missing base bars rather than inventing candles', async () => {
    const { service } = await marketService();
    const dataset = service.importDataset(metadata, FIXTURE_CSV);
    const page = await service.getBars({ provider: 'csv', symbol: dataset.id }, '3', {});
    expect(page.bars).toEqual([
      { time: FIXTURE_START, open: 10, high: 13, low: 9, close: 12, volume: 3 },
      { time: FIXTURE_START + 180000, open: 13, high: 16, low: 12, close: 15, volume: 3 },
    ]);
    const missing = FIXTURE_CSV.split('\n').filter(row => !row.startsWith('2026-01-01T00:02:')).join('\n');
    const gapDataset = service.importDataset(metadata, missing);
    const gapPage = await service.getBars({ provider: 'csv', symbol: gapDataset.id }, '3', {});
    expect(gapPage.gaps).toContainEqual({ from: FIXTURE_START + 120000, to: FIXTURE_START + 180000 });
    expect(gapPage.bars[0].volume).toBe(2);
  });
  it('reports provider failure instead of successful empty live history and never changes venues', async () => {
    const { service, coinbase, binance } = await marketService();
    coinbase.failure = new ApiError(503, 'PROVIDER_UNAVAILABLE', 'Coinbase unavailable');
    await expect(service.getBars({ provider: 'coinbase', symbol: 'BTC-USD' }, '1', {})).rejects.toMatchObject({ statusCode: 503 });
    expect((await service.getBars({ provider: 'binance', symbol: 'BTCUSDT' }, '1', {})).bars).toEqual(FIXTURE_BARS);
    expect(binance.failure).toBeNull();
  });
  it('shares one upstream subscription, persists one confirmed bar and releases it only after the final consumer', async () => {
    const { db, service, coinbase, advance } = await marketService();
    const events: MarketEvent[] = [];
    const ready = Promise.withResolvers<void>();
    const market = { provider: 'coinbase' as const, symbol: 'BTC-USD' };
    const unsubscribeA = service.subscribeBars(market, '1', event => {
      events.push(event);
      if (event.kind === 'status' && event.status === 'live') ready.resolve();
    });
    const unsubscribeB = service.subscribeBars(market, '1', event => events.push(event));
    expect(coinbase.subscriptionStarts).toBe(1);
    await ready.promise;
    advance(FIXTURE_START + 420000);
    const event: MarketEvent = { kind: 'close', bar: { time: FIXTURE_START + 360000, open: 15, high: 16, low: 14, close: 16, volume: 1 }, receivedAt: coinbase.clock() };
    coinbase.emit('1', event);
    coinbase.emit('1', event);
    expect(db.prepare('SELECT count(*) AS count FROM bar_cache WHERE provider=? AND symbol=? AND timeframe=? AND time=?').get('coinbase', 'BTC-USD', '1', event.bar.time)).toEqual({ count: 1 });
    expect(events.filter(item => item.kind === 'close')).toHaveLength(2);
    unsubscribeA();
    expect(coinbase.listeners.size).toBe(1);
    unsubscribeB();
    expect(coinbase.listeners.size).toBe(0);
  });
  it('never confirms an exchange tail from wall clock or exposes a future completed higher-timeframe bar', async () => {
    const { service } = await marketService();
    const native = await service.getConfirmedBars({ provider: 'coinbase', symbol: 'BTC-USD' }, '1', { from: FIXTURE_START, to: FIXTURE_START + 360000 });
    expect(native.bars).toEqual(FIXTURE_BARS.slice(0, 5));
    expect(native.gaps).toContainEqual({ from: FIXTURE_START + 300000, to: FIXTURE_START + 360000 });
    const dataset = service.importDataset(metadata, FIXTURE_CSV);
    const market = { provider: 'csv' as const, symbol: dataset.id };
    expect((await service.getConfirmedBars(market, '5', { from: FIXTURE_START, to: FIXTURE_START + 240000 })).bars).toEqual([]);
    const closed = await service.getConfirmedBars(market, '5', { from: FIXTURE_START, to: FIXTURE_START + 300000 });
    expect(closed.bars).toEqual([{ time: FIXTURE_START, open: 10, high: 15, low: 9, close: 14, volume: 5 }]);
  });
});
