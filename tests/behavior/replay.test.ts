import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { loadConfig } from '../../apps/server/src/config.js';
import { FIXTURE_CSV, FIXTURE_START, FixtureTransport } from '../fixtures/market.js';
import type { DatasetImport, PaperAccountView, ReplaySession } from '../../packages/contracts/src/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function replayApp() {
  const directory = await mkdtemp(join(tmpdir(), 'pineterm-replay-'));
  const clock = () => FIXTURE_START + 360000;
  const config = loadConfig({ PINETERM_ADMIN_PASSWORD: 'replay-test-password', PINETERM_SESSION_SECRET: randomBytes(48).toString('base64'), PINETERM_SECRET_KEY: randomBytes(32).toString('base64'), PINETERM_DATA_DIR: directory, PINETERM_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' });
  const coinbase = new FixtureTransport('coinbase', clock);
  const app = await buildApp({ config, providers: { coinbase, binance: new FixtureTransport('binance', clock) }, clock });
  cleanups.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: { origin: config.publicOrigin }, payload: { password: config.adminPassword } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], origin: config.publicOrigin, 'x-csrf-token': login.json().csrfToken };
  const metadata: DatasetImport = { name: 'Replay fixture', baseCurrency: 'BTC', quoteCurrency: 'USD', timeframe: '1', tickSize: '0.01', quantityStep: '1' };
  const dataset = app.services.market.importDataset(metadata, FIXTURE_CSV);
  return { app, headers, coinbase, market: { provider: 'csv' as const, symbol: dataset.id } };
}

describe('server replay authority', () => {
  it('fills next-open orders only in its separate account and rewind starts a fresh ledger', async () => {
    const { app, headers, coinbase } = await replayApp();
    const market = { provider: 'coinbase' as const, symbol: 'BTC-USD' };
    const live = (await app.inject({ method: 'POST', url: '/api/v1/paper/accounts', headers, payload: { name: 'Untouched live', quoteCurrency: 'USD', initialBalance: '1000', commissionBps: '0', slippageBps: '0' } })).json() as PaperAccountView;
    const request = { markets: [{ market, timeframe: '1' }], from: FIXTURE_START, to: FIXTURE_START + 300000, quoteCurrency: 'USD', initialBalance: '1000', commissionBps: '0', slippageBps: '0' };
    const created = await app.inject({ method: 'POST', url: '/api/v1/replay-sessions', headers, payload: request });
    expect(created.statusCode).toBe(201);
    const session = created.json().session as ReplaySession;
    expect(session.accountId).not.toBe(live.account.id);
    const order = await app.inject({ method: 'POST', url: '/api/v1/paper/orders', headers: { ...headers, 'idempotency-key': 'replay-buy' }, payload: { accountId: session.accountId, market, side: 'buy', type: 'market', quantity: '2' } });
    expect(order.statusCode).toBe(201);
    coinbase.emit('1', { kind: 'quote', quote: { market: { provider: 'coinbase', symbol: 'BTC-USD' }, price: '100', observedAt: FIXTURE_START + 360000, status: 'live', changePercent: null } });
    expect((await app.services.paper.getAccount(session.accountId)).fills).toEqual([]);
    const stepped = await app.inject({ method: 'POST', url: '/api/v1/replay-sessions/' + session.id + '/step', headers });
    expect(stepped.statusCode).toBe(200);
    expect(stepped.json().session.cursor).toBe(FIXTURE_START + 120000);
    const replay = await app.services.paper.getAccount(session.accountId);
    expect(replay.account.cashBalance).toBe('980'); expect(replay.positions[0].quantity).toBe('2'); expect(replay.fills[0].price).toBe('10');
    const untouched = await app.services.paper.getAccount(live.account.id);
    expect(untouched.account.cashBalance).toBe('1000'); expect(untouched.fills).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/v1/replay-sessions/' + session.id + '/stop', headers })).statusCode).toBe(200);
    const rewound = (await app.inject({ method: 'POST', url: '/api/v1/replay-sessions', headers, payload: request })).json().session as ReplaySession;
    expect(rewound.accountId).not.toBe(session.accountId);
    expect((await app.services.paper.getAccount(rewound.accountId)).fills).toEqual([]);
  });
  it('reveals higher-timeframe close values only at the acknowledged boundary', async () => {
    const { app, headers, market } = await replayApp();
    const created = await app.inject({ method: 'POST', url: '/api/v1/replay-sessions', headers, payload: { markets: [{ market, timeframe: '1' }, { market, timeframe: '5' }], from: FIXTURE_START, to: FIXTURE_START + 300000, quoteCurrency: 'USD' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().session.id;
    for (let step = 0; step < 3; step++) app.services.replay.step(id);
    const before = await app.services.replay.getBars(id, market, '5');
    expect(before.bars).toEqual([]);
    app.services.replay.step(id);
    const closed = await app.services.replay.getBars(id, market, '5');
    expect(closed.bars[0].close).toBe(14);
    // An in-flight request from the previous cursor must not gain a future HTF bar after server advancement.
    const previousCursor = await app.services.replay.getBars(id, market, '5', { to: FIXTURE_START + 240000 });
    expect(previousCursor.bars).toEqual([]);
  });
  it('rejects orders on unselected replay markets and stopped-session data', async () => {
    const { app, headers, market } = await replayApp();
    const created = await app.inject({ method: 'POST', url: '/api/v1/replay-sessions', headers, payload: { markets: [{ market, timeframe: '1' }], from: FIXTURE_START, to: FIXTURE_START + 360000, quoteCurrency: 'USD' } });
    const session = created.json().session as ReplaySession;
    const foreign = await app.inject({ method: 'POST', url: '/api/v1/paper/orders', headers: { ...headers, 'idempotency-key': 'foreign' }, payload: { accountId: session.accountId, market: { provider: 'coinbase', symbol: 'BTC-USD' }, side: 'buy', type: 'market', quantity: '1' } });
    expect(foreign.statusCode).toBe(422);
    app.services.replay.stop(session.id);
    await expect(app.services.replay.getBars(session.id, market, '1')).rejects.toMatchObject({ statusCode: 409 });
  });
});
