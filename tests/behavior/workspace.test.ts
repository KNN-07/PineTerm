import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { loadConfig } from '../../apps/server/src/config.js';
import { FIXTURE_START, FixtureTransport } from '../fixtures/market.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const state = { version: 1, layout: '1', charts: [{ id: 'main', symbol: 'COINBASE:BTC-USD', timeframe: '60', priceStyle: 'candles' }], ext: { 'pineterm.fixture': { retained: true } } };
async function workspaceApp() {
  const directory = await mkdtemp(join(tmpdir(), 'pineterm-workspace-'));
  const config = loadConfig({ PINETERM_ADMIN_PASSWORD: 'workspace-test-password', PINETERM_SESSION_SECRET: randomBytes(48).toString('base64'), PINETERM_SECRET_KEY: randomBytes(32).toString('base64'), PINETERM_DATA_DIR: directory, PINETERM_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' });
  const clock = () => FIXTURE_START + 360000;
  let app = await buildApp({ config, providers: { coinbase: new FixtureTransport('coinbase', clock), binance: new FixtureTransport('binance', clock) }, clock });
  cleanups.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: { origin: config.publicOrigin }, payload: { password: config.adminPassword } });
  expect(login.statusCode).toBe(200);
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], origin: config.publicOrigin, 'x-csrf-token': login.json().csrfToken };
  return {
    app, headers,
    restart: async () => {
      await app.close();
      app = await buildApp({ config, providers: { coinbase: new FixtureTransport('coinbase', clock), binance: new FixtureTransport('binance', clock) }, clock });
      return app;
    },
  };
}

describe('durable workspaces and ordered watchlists', () => {
  it('allows only one concurrent save for a revision and preserves the winner across restart', async () => {
    const { app, headers, restart } = await workspaceApp();
    const created = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Research', velaState: state, uiState: { bottomHeight: 260 } } });
    expect(created.statusCode).toBe(201);
    const workspace = created.json().workspace;
    const saves = await Promise.all(['2h', '4'].map(layout => app.inject({ method: 'PUT', url: '/api/v1/workspaces/' + workspace.id, headers, payload: { name: 'Research', revision: workspace.revision, velaState: { ...state, layout }, uiState: { bottomHeight: 300 } } })));
    expect(saves.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const winner = saves.find(response => response.statusCode === 200)!.json().workspace;
    const conflict = saves.find(response => response.statusCode === 409)!.json();
    expect(conflict.error.details.currentRevision).toBe(winner.revision);
    const restarted = await restart();
    const restored = await restarted.inject({ url: '/api/v1/workspaces/' + workspace.id, headers });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().workspace).toEqual(winner);
  });
  it('preserves an invalid versioned state for recovery instead of silently sanitizing it', async () => {
    const { app, headers } = await workspaceApp();
    const invalidState = { version: 99, layout: 'unrecognized-layout', charts: [], ext: { userNotes: 'recover this document' } };
    const created = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Recovery', velaState: invalidState, uiState: {} } });
    expect(created.statusCode).toBe(201);
    const restored = await app.inject({ url: '/api/v1/workspaces/' + created.json().workspace.id, headers });
    expect(restored.json().workspace.velaState).toEqual(invalidState);
  });
  it('atomically reorders venue-qualified symbols and rejects duplicate rows without changing the list', async () => {
    const { app, headers } = await workspaceApp();
    const items = [{ provider: 'coinbase', symbol: 'BTC-USD' }, { provider: 'binance', symbol: 'BTCUSDT' }];
    const created = await app.inject({ method: 'POST', url: '/api/v1/watchlists', headers, payload: { name: 'Distinct venues', items } });
    expect(created.statusCode).toBe(201);
    const original = created.json().watchlist;
    const reordered = await app.inject({ method: 'PUT', url: '/api/v1/watchlists/' + original.id, headers, payload: { name: original.name, revision: original.revision, items: [...items].reverse() } });
    expect(reordered.statusCode).toBe(200);
    const current = reordered.json().watchlist;
    expect(current.items).toEqual([...items].reverse());
    const duplicate = await app.inject({ method: 'PUT', url: '/api/v1/watchlists/' + original.id, headers, payload: { name: original.name, revision: current.revision, items: [items[0], items[0]] } });
    expect(duplicate.statusCode).toBe(400);
    const restored = await app.inject({ url: '/api/v1/watchlists/' + original.id, headers });
    expect(restored.json().watchlist).toEqual(current);
  });
  it('does not give market readers access to saved personal workspaces', async () => {
    const { app, headers } = await workspaceApp();
    const key = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers, payload: { name: 'Market-only', scopes: ['market:read'] } });
    expect(key.statusCode).toBe(201);
    const response = await app.inject({ url: '/api/v1/workspaces', headers: { authorization: `Bearer ${key.json().token}` } });
    expect(response.statusCode).toBe(403);
  });
});
