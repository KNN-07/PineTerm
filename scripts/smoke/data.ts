import assert from 'node:assert/strict';
import WebSocket from 'ws';
import type { BarPage, Dataset, Instrument } from '../../packages/contracts/src/market.js';
import { FIXTURE_BARS, FIXTURE_CSV, FIXTURE_START, type FixtureTransport } from '../../tests/fixtures/market.js';
import { ApiError } from '../../apps/server/src/errors.js';

export async function runDataScenario(url: string, sessionHeaders: Record<string, string>, fixture: FixtureTransport, advanceClock: (value: number) => void): Promise<void> {
  const { 'Content-Type': _contentType, ...headers } = sessionHeaders;
  const form = new FormData();
  for (const [key, value] of Object.entries({ name: 'Six-bar fixture', baseCurrency: 'BTC', quoteCurrency: 'USD', timeframe: '1', tickSize: '0.01', quantityStep: '1' })) form.set(key, value);
  form.set('file', new Blob([FIXTURE_CSV], { type: 'text/csv' }), 'fixture.csv');
  const imported = await fetch(url + '/api/v1/datasets', { method: 'POST', headers, body: form });
  assert.equal(imported.status, 201, await imported.clone().text());
  const { dataset } = await imported.json() as { dataset: Dataset };
  assert.equal(dataset.rowCount, 6);
  const query = `provider=csv&symbol=${dataset.id}&timeframe=1`;
  const response = await fetch(url + '/api/v1/bars?' + query, { headers });
  assert.equal(response.status, 200, await response.clone().text());
  const page = await response.json() as BarPage;
  assert.equal(page.status, 'historical');
  assert.deepEqual(page.bars, FIXTURE_BARS);
  const rangeResponse = await fetch(url + `/api/v1/bars?${query}&from=${FIXTURE_START + 60000}&to=${FIXTURE_START + 240000}`, { headers });
  assert.deepEqual((await rangeResponse.json() as BarPage).bars, FIXTURE_BARS.slice(1, 4));
  const paged = await (await fetch(url + `/api/v1/bars?${query}&limit=2`, { headers })).json() as BarPage;
  assert.deepEqual(paged.bars, FIXTURE_BARS.slice(4));
  assert.equal(paged.nextBefore, FIXTURE_START + 240000);
  const older = await (await fetch(url + `/api/v1/bars?${query}&limit=2&to=${paged.nextBefore}`, { headers })).json() as BarPage;
  assert.deepEqual(older.bars, FIXTURE_BARS.slice(2, 4));
  const csv = await (await fetch(url + '/api/v1/bars.csv?' + query, { headers })).text();
  const exportedRows = csv.trim().split('\n').slice(1).map(row => row.replace(/\r$/, '').split(','));
  assert.deepEqual(exportedRows.map(row => ({ time: /^\d+$/.test(row[0]) ? Number(row[0]) : Date.parse(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) })), FIXTURE_BARS);
  form.set('file', new Blob([FIXTURE_CSV + FIXTURE_CSV.split('\n')[1] + '\n']), 'duplicate.csv');
  assert.equal((await fetch(url + '/api/v1/datasets', { method: 'POST', headers, body: form })).status, 400);
  form.set('file', new Blob(['time,open,high,low,close,volume\n2026-01-01T00:00:00Z,10,9,8,10,1\n']), 'invalid.csv');
  assert.equal((await fetch(url + '/api/v1/datasets', { method: 'POST', headers, body: form })).status, 400);
  const datasets = await (await fetch(url + '/api/v1/markets?provider=csv', { headers })).json() as { markets: Instrument[] };
  assert.deepEqual(datasets.markets.map(item => item.market.symbol), [dataset.id]);

  const socket = new WebSocket(url.replace('http:', 'ws:') + '/api/v1/stream', { headers });
  const stream = Promise.withResolvers<{ type: string; payload: unknown }>();
  const timeout = setTimeout(() => stream.reject(new Error('No authoritative WebSocket bar update')), 5000);
  socket.on('error', stream.reject);
  let emitted = false;
  socket.on('message', bytes => {
    const event = JSON.parse(bytes.toString());
    if (event.type === 'status' && fixture.listeners.size && !emitted) {
      emitted = true;
      advanceClock(FIXTURE_START + 420000);
      const bar = { time: FIXTURE_START + 360000, open: 15, high: 16, low: 14, close: 15.5, volume: 1 };
      fixture.series.get('1')!.push(bar);
      fixture.emit('1', { kind: 'close', bar, receivedAt: fixture.clock() });
    }
    if (event.type === 'bar') stream.resolve(event);
  });
  socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', channel: 'bars', market: { provider: 'coinbase', symbol: 'BTC-USD' }, timeframe: '1' })));
  try {
    const event = await stream.promise;
    assert.equal(event.type, 'bar');
    console.log('data: reverse CSV → six exact ascending bars; half-open range; exclusive pagination; export round-trip; atomic invalid imports; authenticated WebSocket confirmed bar', JSON.stringify(event.payload));
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
  fixture.failure = new ApiError(503, 'PROVIDER_UNAVAILABLE', 'Fixture venue disconnected');
  const staleResponse = await fetch(url + '/api/v1/bars?provider=coinbase&symbol=BTC-USD&timeframe=1', { headers });
  assert.equal(staleResponse.status, 200);
  const stale = await staleResponse.json() as BarPage;
  assert.equal(stale.status, 'stale');
  assert.equal(stale.providerError?.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(stale.bars.at(-1)?.close, 15.5);
  console.log('data: provider failure returned explicit stale cache and providerError, not empty live history');
  fixture.failure = null;
}
