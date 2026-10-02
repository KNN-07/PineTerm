import assert from 'node:assert/strict';
import type { PaperAccountView, PaperOrder, Quote } from '../../packages/contracts/src/index.js';
import type { FixtureTransport } from '../../tests/fixtures/market.js';

export async function runPaperScenario(url: string, headers: Record<string, string>, fixture: FixtureTransport, advanceClock: (value: number) => void, restart: () => Promise<void>): Promise<void> {
  const { 'Content-Type': _contentType, ...plainHeaders } = headers;
  const market = { provider: 'coinbase' as const, symbol: 'BTC-USD' };
  const created = await fetch(url + '/api/v1/paper/accounts', { method: 'POST', headers, body: JSON.stringify({ name: 'Paper acceptance fixture', quoteCurrency: 'USD', initialBalance: '1000', commissionBps: '0', slippageBps: '0' }) });
  assert.equal(created.status, 201, await created.clone().text());
  const view = await created.json() as PaperAccountView;
  const accountId = view.account.id;
  const account = async (): Promise<PaperAccountView> => {
    const response = await fetch(url + '/api/v1/paper/accounts/' + accountId, { headers });
    assert.equal(response.status, 200);
    return await response.json() as PaperAccountView;
  };
  const quote = (price: string, stale = false): void => {
    advanceClock(fixture.clock() + 1000);
    const value: Quote = { market, price, observedAt: fixture.clock() - (stale ? 31000 : 0), status: stale ? 'stale' : 'live', changePercent: null };
    fixture.emit('1', { kind: 'quote', quote: value });
  };
  // Earlier smoke scenarios may advance the shared clock; establish a fresh reference before acceptance.
  quote('10');
  const buyBody = { accountId, market, side: 'buy', type: 'market', quantity: '2' };
  const buy = await fetch(url + '/api/v1/paper/orders', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'paper-buy-two' }, body: JSON.stringify(buyBody) });
  assert.equal(buy.status, 201, await buy.clone().text());
  const firstOrder = (await buy.json() as { order: PaperOrder }).order;
  assert.equal(firstOrder.state, 'open');
  assert.equal((await account()).fills.length, 0);
  quote('10');
  const bought = await account();
  assert.equal(bought.account.cashBalance, '980'); assert.equal(bought.positions[0].quantity, '2');
  const retry = await fetch(url + '/api/v1/paper/orders', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'paper-buy-two' }, body: JSON.stringify(buyBody) });
  assert.equal((await retry.json() as { order: PaperOrder }).order.id, firstOrder.id);
  const conflict = await fetch(url + '/api/v1/paper/orders', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'paper-buy-two' }, body: JSON.stringify({ ...buyBody, quantity: '1' }) });
  assert.equal(conflict.status, 409);
  const sell = await fetch(url + '/api/v1/paper/orders', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'paper-sell-one' }, body: JSON.stringify({ ...buyBody, side: 'sell', quantity: '1' }) });
  assert.equal(sell.status, 201, await sell.clone().text());
  quote('12');
  const sold = await account();
  assert.equal(sold.account.cashBalance, '992'); assert.equal(sold.positions[0].quantity, '1'); assert.equal(sold.positions[0].realizedPnl, '2'); assert.equal(sold.fills.length, 2);

  const limitBody = { accountId, market, side: 'buy', type: 'limit', quantity: '1', limitPrice: '9' };
  const limit = await fetch(url + '/api/v1/paper/orders', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'paper-limit-nine' }, body: JSON.stringify(limitBody) });
  assert.equal(limit.status, 201);
  const limitId = (await limit.json() as { order: PaperOrder }).order.id;
  quote('10'); assert.equal((await account()).orders.find(order => order.id === limitId)?.state, 'open');
  quote('8', true); assert.equal((await account()).orders.find(order => order.id === limitId)?.state, 'open');
  quote('8'); const atBetter = await account();
  assert.equal(atBetter.fills.find(fill => fill.orderId === limitId)?.price, '8');
  assert.equal(atBetter.account.cashBalance, '984');
  const pending = await fetch(url + '/api/v1/paper/orders', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'paper-cancel' }, body: JSON.stringify({ ...limitBody, limitPrice: '7' }) });
  assert.equal(pending.status, 201);
  const pendingId = (await pending.json() as { order: PaperOrder }).order.id;
  assert.equal((await fetch(url + '/api/v1/paper/orders/' + pendingId + '/cancel', { method: 'POST', headers: plainHeaders })).status, 200);
  quote('6');
  const cancelled = await account();
  assert.equal(cancelled.orders.find(order => order.id === pendingId)?.state, 'cancelled');
  assert.equal(cancelled.fills.some(fill => fill.orderId === pendingId), false);

  const before = await account();
  await restart();
  const persisted = await account();
  assert.equal(persisted.account.cashBalance, before.account.cashBalance);
  assert.deepEqual(persisted.fills, before.fills); assert.deepEqual(persisted.ledger, before.ledger);
  console.log('paper: real HTTP buy2@10 cash980; sell1@12 cash992/holding1/realized2; same key one fill; stale limit waits → fills@8; cancellation remains terminal; restart preserves fills/ledger/cash984');
}
