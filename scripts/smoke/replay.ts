import assert from 'node:assert/strict';
import type { PaperAccountView, ReplaySession } from '../../packages/contracts/src/index.js';
import { FIXTURE_CSV, FIXTURE_START } from '../../tests/fixtures/market.js';

export async function runReplayScenario(url: string, headers: Record<string, string>): Promise<void> {
  const { 'Content-Type': _contentType, ...plainHeaders } = headers;
  const data = new FormData();
  for (const [key, value] of Object.entries({ name: 'Replay HTTP fixture', baseCurrency: 'BTC', quoteCurrency: 'USD', timeframe: '1', tickSize: '0.01', quantityStep: '1' })) data.set(key, value);
  data.set('file', new Blob([FIXTURE_CSV]), 'replay-fixture.csv');
  const imported = await fetch(url + '/api/v1/datasets', { method: 'POST', headers: plainHeaders, body: data });
  assert.equal(imported.status, 201, await imported.clone().text());
  const dataset = (await imported.json() as { dataset: { id: string } }).dataset;
  const market = { provider: 'csv', symbol: dataset.id };
  const liveCreated = await fetch(url + '/api/v1/paper/accounts', { method: 'POST', headers, body: JSON.stringify({ name: 'Replay isolation live account', quoteCurrency: 'USD', initialBalance: '1000', commissionBps: '0', slippageBps: '0' }) });
  assert.equal(liveCreated.status, 201);
  const live = await liveCreated.json() as PaperAccountView;
  const body = { markets: [{ market, timeframe: '1' }, { market, timeframe: '5' }], from: FIXTURE_START, to: FIXTURE_START + 300000, quoteCurrency: 'USD', initialBalance: '1000', commissionBps: '0', slippageBps: '0' };
  const created = await fetch(url + '/api/v1/replay-sessions', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(created.status, 201, await created.clone().text());
  const session = (await created.json() as { session: ReplaySession }).session;
  assert.equal(session.cursor, FIXTURE_START + 60000);
  assert.notEqual(session.accountId, live.account.id);
  const placed = await fetch(url + '/api/v1/paper/orders', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'replay-http-buy' }, body: JSON.stringify({ accountId: session.accountId, market, side: 'buy', type: 'market', quantity: '2' }) });
  assert.equal(placed.status, 201, await placed.clone().text());
  for (let step = 0; step < 3; step++) {
    const response = await fetch(url + '/api/v1/replay-sessions/' + session.id + '/step', { method: 'POST', headers: plainHeaders });
    assert.equal(response.status, 200, await response.clone().text());
  }
  const barsQuery = `provider=csv&symbol=${dataset.id}&timeframe=5&replaySessionId=${session.id}`;
  const before = await (await fetch(url + '/api/v1/bars?' + barsQuery, { headers })).json() as { bars: unknown[] };
  assert.deepEqual(before.bars, []);
  const current = await (await fetch(url + '/api/v1/paper/accounts/' + session.accountId, { headers })).json() as PaperAccountView;
  assert.equal(current.account.cashBalance, '980'); assert.equal(current.positions[0].quantity, '2'); assert.equal(current.fills[0].price, '10');
  const closure = await fetch(url + '/api/v1/replay-sessions/' + session.id + '/step', { method: 'POST', headers: plainHeaders });
  assert.equal(closure.status, 200);
  const closed = await (await fetch(url + '/api/v1/bars?' + barsQuery, { headers })).json() as { bars: Array<{ close: number }> };
  assert.equal(closed.bars[0].close, 14);
  const prior = await (await fetch(url + '/api/v1/bars?' + barsQuery + '&to=' + (FIXTURE_START + 240000), { headers })).json() as { bars: unknown[] };
  assert.deepEqual(prior.bars, []);
  const untouched = await (await fetch(url + '/api/v1/paper/accounts/' + live.account.id, { headers })).json() as PaperAccountView;
  assert.equal(untouched.account.cashBalance, '1000'); assert.deepEqual(untouched.fills, []);
  assert.equal((await fetch(url + '/api/v1/replay-sessions/' + session.id + '/stop', { method: 'POST', headers: plainHeaders })).status, 200);
  assert.equal((await fetch(url + '/api/v1/bars?' + barsQuery, { headers })).status, 409);
  const rewoundResponse = await fetch(url + '/api/v1/replay-sessions', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(rewoundResponse.status, 201);
  const rewound = (await rewoundResponse.json() as { session: ReplaySession }).session;
  assert.notEqual(rewound.accountId, session.accountId);
  const fresh = await (await fetch(url + '/api/v1/paper/accounts/' + rewound.accountId, { headers })).json() as PaperAccountView;
  assert.equal(fresh.account.cashBalance, '1000'); assert.deepEqual(fresh.fills, []);
  assert.equal((await fetch(url + '/api/v1/replay-sessions/' + rewound.id + '/stop', { method: 'POST', headers: plainHeaders })).status, 200);
  console.log('replay: real HTTP server-acknowledged cursor; next-open buy2@10 cash980; 5m future value absent at 00:04 → 14 at 00:05; old-cursor request stayed clipped; live ledger unchanged; rewind fresh account; stopped data409');
}
