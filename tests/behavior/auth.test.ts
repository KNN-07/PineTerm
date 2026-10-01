import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { loadConfig } from '../../apps/server/src/config.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function authenticatedApp() {
  const dataDir = await mkdtemp(join(tmpdir(), 'pineterm-auth-'));
  const config = loadConfig({ PINETERM_ADMIN_PASSWORD: 'a-test-only-password', PINETERM_SESSION_SECRET: randomBytes(48).toString('base64'), PINETERM_SECRET_KEY: randomBytes(32).toString('base64'), PINETERM_DATA_DIR: dataDir, PINETERM_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' });
  const app = await buildApp({ config });
  cleanups.push(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: { origin: config.publicOrigin }, payload: { password: config.adminPassword } });
  expect(login.statusCode).toBe(200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const session = await app.inject({ url: '/api/v1/session', headers: { cookie } });
  const headers = { cookie, origin: config.publicOrigin, 'x-csrf-token': session.json().csrfToken };
  return { app, config, headers };
}

describe('admin and scoped API key boundary', () => {
  it('rejects unknown command fields and executor scopes without an executor binding', async () => {
    const { app, headers } = await authenticatedApp();
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers, payload: { name: 'key', scopes: ['market:read'], administrator: true } });
    expect(unknown.statusCode).toBe(400);
    const executor = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers, payload: { name: 'unbound', scopes: ['executor:report'] } });
    expect([400, 422]).toContain(executor.statusCode);
  });
  it('never grants key creation privileges to an API key and invalidates logged-out sessions', async () => {
    const { app, headers } = await authenticatedApp();
    const created = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers, payload: { name: 'paper client', scopes: ['paper:trade'] } });
    expect(created.statusCode).toBe(201);
    const bearer = { authorization: `Bearer ${created.json().token}` };
    const escalation = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: bearer, payload: { name: 'escalate', scopes: ['live:intent'] } });
    expect(escalation.statusCode).toBe(403);
    const logout = await app.inject({ method: 'DELETE', url: '/api/v1/session', headers });
    expect(logout.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/api-keys', headers })).statusCode).toBe(401);
  });
  it('blocks cross-site writes even when the attacker possesses a valid CSRF token', async () => {
    const { app, headers } = await authenticatedApp();
    const response = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: { ...headers, origin: 'https://attacker.example' }, payload: { name: 'stolen', scopes: ['market:read'] } });
    expect(response.statusCode).toBe(403);
  });
});
