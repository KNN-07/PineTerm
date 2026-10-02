import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/server/src/app.js';
import { loadConfig } from '../../apps/server/src/config.js';
import { FIXTURE_START, FixtureTransport } from '../fixtures/market.js';
import type { PaperAccountView, PaperOrder, Quote } from '../../packages/contracts/src/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const market = { provider: 'coinbase' as const, symbol: 'BTC-USD' };
async function paperApp() {
  const directory = await mkdtemp(join(tmpdir(), 'pineterm-paper-'));
  let now = FIXTURE_START + 360000;
  const clock = () => now;
  let coinbase = new FixtureTransport('coinbase', clock);
  const config = loadConfig({ PINETERM_ADMIN_PASSWORD: 'paper-test-password', PINETERM_SESSION_SECRET: randomBytes(48).toString('base64'), PINETERM_SECRET_KEY: randomBytes(32).toString('base64'), PINETERM_DATA_DIR: directory, PINETERM_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' });
  let app = await buildApp({ config, providers: { coinbase, binance: new FixtureTransport('binance', clock) }, clock });
  cleanups.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: { origin: config.publicOrigin }, payload: { password: config.adminPassword } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], origin: config.publicOrigin, 'x-csrf-token': login.json().csrfToken };
  return {
    app, headers,
    quote: (price: string, age = 0) => {
      now += 1000;
      const quote: Quote = { market, price, observedAt: now - age, status: age > 30000 ? 'stale' : 'live', changePercent: null };
      coinbase.emit('1', { kind: 'quote', quote });
      return quote;
    },
    restart: async () => {
      const latest = coinbase.quote;
      await app.close(); coinbase = new FixtureTransport('coinbase', clock); coinbase.quote = latest;
      app = await buildApp({ config, providers: { coinbase, binance: new FixtureTransport('binance', clock) }, clock });
      return app;
    },
  };
}

async function account(app: FastifyInstance, headers: Record<string, string>) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/paper/accounts', headers, payload: { name: 'USD fixture', quoteCurrency: 'USD', initialBalance: '1000', commissionBps: '0', slippageBps: '0' } });
  expect(response.statusCode).toBe(201);
  return response.json() as PaperAccountView;
}

describe('server-authoritative spot paper accounting', () => {
  it('rejects zero order amounts and never fills on a zero-price observation', async () => {
    const fixture = await paperApp();
    const view = await account(fixture.app, fixture.headers);
    const body = { accountId: view.account.id, market, side: 'buy', type: 'market', quantity: '1' };
    for (const [index, changes] of [{ quantity: '0' }, { type: 'limit', limitPrice: '0' }, { type: 'stop', stopPrice: '0' }].entries()) {
      const invalid = await fixture.app.inject({ method: 'POST', url: '/api/v1/paper/orders', headers: { ...fixture.headers, 'idempotency-key': 'zero-' + index }, payload: { ...body, ...changes } });
      expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
    }
    const placed = await fixture.app.inject({ method: 'POST', url: '/api/v1/paper/orders', headers: { ...fixture.headers, 'idempotency-key': 'valid-after-zero' }, payload: body });
    expect(placed.statusCode).toBe(201);
    fixture.quote('0');
    const blocked = await fixture.app.services.paper.getAccount(view.account.id);
    expect(blocked.fills).toEqual([]); expect(blocked.account.cashBalance).toBe('1000');
    fixture.quote('10');
    const filled = await fixture.app.services.paper.getAccount(view.account.id);
    expect(filled.fills).toHaveLength(1); expect(filled.fills[0].price).toBe('10'); expect(filled.account.cashBalance).toBe('990');
  });
  it('uses a new quote, dedupes idempotency, realizes exact P/L and survives restart', async () => {
    const fixture = await paperApp();
    const view = await account(fixture.app, fixture.headers);
    const body = { accountId: view.account.id, market, side: 'buy', type: 'market', quantity: '2' };
    const placed = await fixture.app.inject({ method: 'POST', url: '/api/v1/paper/orders', headers: { ...fixture.headers, 'idempotency-key': 'first-buy' }, payload: body });
    expect(placed.statusCode).toBe(201);
    expect(placed.json().order.state).toBe('open');
    fixture.quote('10');
    const bought = (await fixture.app.inject({ url: '/api/v1/paper/accounts/' + view.account.id, headers: fixture.headers })).json() as PaperAccountView;
    expect(bought.account.cashBalance).toBe('980'); expect(bought.positions[0].quantity).toBe('2');
    const repeated = await fixture.app.inject({ method: 'POST', url: '/api/v1/paper/orders', headers: { ...fixture.headers, 'idempotency-key': 'first-buy' }, payload: body });
    expect(repeated.json().order.id).toBe(placed.json().order.id);
    expect((await fixture.app.inject({ method: 'POST', url: '/api/v1/paper/orders', headers: { ...fixture.headers, 'idempotency-key': 'first-buy' }, payload: { ...body, quantity: '1' } })).statusCode).toBe(409);
    expect((await fixture.app.inject({ method: 'POST', url: '/api/v1/paper/orders', headers: { ...fixture.headers, 'idempotency-key': 'sell-one' }, payload: { ...body, side: 'sell', quantity: '1' } })).statusCode).toBe(201);
    fixture.quote('12');
    const sold = (await fixture.app.inject({ url: '/api/v1/paper/accounts/' + view.account.id, headers: fixture.headers })).json() as PaperAccountView;
    expect(sold.account.cashBalance).toBe('992'); expect(sold.positions[0].quantity).toBe('1'); expect(sold.positions[0].realizedPnl).toBe('2'); expect(sold.fills).toHaveLength(2);
    const restarted = await fixture.restart();
    const persisted = (await restarted.inject({ url: '/api/v1/paper/accounts/' + view.account.id, headers: fixture.headers })).json() as PaperAccountView;
    expect(persisted.account.cashBalance).toBe('992'); expect(persisted.positions[0].costBasis).toBe(sold.positions[0].costBasis); expect(persisted.ledger).toEqual(sold.ledger);
  });
  it('prevents concurrent cash over-reservation and releases cancelled limits', async () => {
    const fixture = await paperApp(); const view = await account(fixture.app, fixture.headers);
    const payload = { accountId: view.account.id, market, side: 'buy', type: 'limit', quantity: '80', limitPrice: '9' };
    const competing = await Promise.all(['A', 'B'].map(key => fixture.app.inject({ method: 'POST', url: '/api/v1/paper/orders', headers: { ...fixture.headers, 'idempotency-key': key }, payload })));
    expect(competing.map(response => response.statusCode).sort()).toEqual([201, 422]);
    const order = competing.find(response => response.statusCode === 201)!.json().order as PaperOrder;
    fixture.quote('10');
    expect((await fixture.app.inject({ url: '/api/v1/paper/accounts/' + view.account.id, headers: fixture.headers })).json().account.reservedCash).toBe('720');
    expect((await fixture.app.inject({ method: 'POST', url: '/api/v1/paper/orders/' + order.id + '/cancel', headers: fixture.headers })).statusCode).toBe(200);
    fixture.quote('8');
    const cancelled = (await fixture.app.inject({ url: '/api/v1/paper/accounts/' + view.account.id, headers: fixture.headers })).json() as PaperAccountView;
    expect(cancelled.account.cashBalance).toBe('1000'); expect(cancelled.account.reservedCash).toBe('0'); expect(cancelled.fills).toEqual([]);
  });
  it('does not fill stale quotes and enforces at-or-better limit prices', async () => {
    const fixture = await paperApp(); const view = await account(fixture.app, fixture.headers);
    const placed = await fixture.app.inject({ method: 'POST', url: '/api/v1/paper/orders', headers: { ...fixture.headers, 'idempotency-key': 'limit' }, payload: { accountId: view.account.id, market, side: 'buy', type: 'limit', quantity: '1', limitPrice: '9' } });
    expect(placed.statusCode).toBe(201);
    fixture.quote('8', 31000);
    const stale = (await fixture.app.inject({ url: '/api/v1/paper/accounts/' + view.account.id, headers: fixture.headers })).json() as PaperAccountView;
    expect(stale.account.cashBalance).toBe('1000'); expect(stale.orders[0].state).toBe('open');
    fixture.quote('8');
    const filled = (await fixture.app.inject({ url: '/api/v1/paper/accounts/' + view.account.id, headers: fixture.headers })).json() as PaperAccountView;
    expect(filled.fills[0].price).toBe('8'); expect(filled.account.cashBalance).toBe('992');
  });
  it('includes costs in basis and never overspends when a fill gaps beyond affordable funds', async () => {
    const fixture = await paperApp();
    const expensive = await fixture.app.inject({ method: 'POST', url: '/api/v1/paper/accounts', headers: fixture.headers, payload: { name: 'Costs', quoteCurrency: 'USD', initialBalance: '1000', commissionBps: '10', slippageBps: '100' } });
    const accountId = expensive.json().account.id;
    expect((await fixture.app.inject({ method: 'POST', url: '/api/v1/paper/orders', headers: { ...fixture.headers, 'idempotency-key': 'costs' }, payload: { accountId, market, side: 'buy', type: 'market', quantity: '2' } })).statusCode).toBe(201);
    fixture.quote('10');
    const costs = await fixture.app.services.paper.getAccount(accountId);
    expect(costs.fills[0]).toMatchObject({ price: '10.1', fee: '0.0202' });
    expect(costs.account.cashBalance).toBe('979.7798'); expect(costs.positions[0].costBasis).toBe('20.2202');
    const small = await fixture.app.inject({ method: 'POST', url: '/api/v1/paper/accounts', headers: fixture.headers, payload: { name: 'Gap', quoteCurrency: 'USD', initialBalance: '25', commissionBps: '0', slippageBps: '0' } });
    const smallId = small.json().account.id;
    expect((await fixture.app.inject({ method: 'POST', url: '/api/v1/paper/orders', headers: { ...fixture.headers, 'idempotency-key': 'gap' }, payload: { accountId: smallId, market, side: 'buy', type: 'market', quantity: '2' } })).statusCode).toBe(201);
    fixture.quote('20');
    const gap = await fixture.app.services.paper.getAccount(smallId);
    expect(gap.account.cashBalance).toBe('25'); expect(gap.account.reservedCash).toBe('0'); expect(gap.orders[0].state).toBe('rejected'); expect(gap.fills).toEqual([]);
  });
  it('requires explicit reset confirmation and retains the archived ledger', async () => {
    const fixture = await paperApp(); const view = await account(fixture.app, fixture.headers);
    const path = '/api/v1/paper/accounts/' + view.account.id + '/reset';
    expect((await fixture.app.inject({ method: 'POST', url: path, headers: fixture.headers, payload: { confirm: false } })).statusCode).toBe(400);
    const reset = await fixture.app.inject({ method: 'POST', url: path, headers: fixture.headers, payload: { confirm: true } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().account.id).not.toBe(view.account.id); expect(reset.json().account.cashBalance).toBe('1000');
    const old = await fixture.app.services.paper.getAccount(view.account.id);
    expect(old.account.archivedAt).not.toBeNull(); expect(old.ledger[0].kind).toBe('initial_balance');
  });
});
