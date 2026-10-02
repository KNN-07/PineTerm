import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { loadConfig } from '../../apps/server/src/config.js';
import { FIXTURE_START, FixtureTransport } from '../fixtures/market.js';
import { SMA_SOURCE } from '../fixtures/pine.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function scriptApp() {
  const directory = await mkdtemp(join(tmpdir(), 'pineterm-scripts-'));
  const clock = () => FIXTURE_START + 360000;
  const config = loadConfig({ PINETERM_ADMIN_PASSWORD: 'script-test-password', PINETERM_SESSION_SECRET: randomBytes(48).toString('base64'), PINETERM_SECRET_KEY: randomBytes(32).toString('base64'), PINETERM_DATA_DIR: directory, PINETERM_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' });
  const app = await buildApp({ config, providers: { coinbase: new FixtureTransport('coinbase', clock), binance: new FixtureTransport('binance', clock) }, clock });
  cleanups.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: { origin: config.publicOrigin }, payload: { password: config.adminPassword } });
  expect(login.statusCode).toBe(200);
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], origin: config.publicOrigin, 'x-csrf-token': login.json().csrfToken };
  return { app, headers };
}

describe('immutable script library revisions', () => {
  it('retains old revision provenance across competing saves and archival', async () => {
    const { app, headers } = await scriptApp();
    const created = await app.inject({ method: 'POST', url: '/api/v1/scripts', headers, payload: { name: 'Research', source: SMA_SOURCE, inputs: {}, props: {} } });
    expect(created.statusCode).toBe(201);
    const original = created.json();
    const writes = await Promise.all([3, 4].map(length => app.inject({ method: 'PUT', url: '/api/v1/scripts/' + original.script.id, headers, payload: { name: 'Research revised', revision: original.script.revision, source: SMA_SOURCE.replace('input.int(2', `input.int(${length}`), inputs: {}, props: {} } })));
    expect(writes.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const latest = writes.find(response => response.statusCode === 200)!.json();
    expect(latest.revision.id).not.toBe(original.revision.id);
    expect(latest.revision.sourceHash).not.toBe(original.revision.sourceHash);
    expect(() => app.db.prepare('UPDATE script_revisions SET source=? WHERE id=?').run('overwrite', original.revision.id)).toThrow();
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/scripts/' + original.script.id, headers })).statusCode).toBe(204);
    const history = await app.inject({ url: '/api/v1/scripts/' + original.script.id + '/revisions', headers });
    expect(history.json().revisions.find((row: { id: string }) => row.id === original.revision.id).sourceHash).toBe(original.revision.sourceHash);
    const list = await app.inject({ url: '/api/v1/scripts', headers });
    expect(list.json().scripts.some((row: { id: string }) => row.id === original.script.id)).toBe(false);
  });
  it('accepts comment preludes but rejects unsupported language annotations and JavaScript entry points', async () => {
    const { app, headers } = await scriptApp();
    const valid = await app.inject({ method: 'POST', url: '/api/v1/scripts', headers, payload: { name: 'Comment prelude', source: '// Original author/license comment\n' + SMA_SOURCE, inputs: {}, props: {} } });
    expect(valid.statusCode).toBe(201);
    expect(valid.json().revision.languageVersion).toBe(6);
    for (const source of ['//@version=4\n' + SMA_SOURCE, '() => 1']) {
      expect((await app.inject({ method: 'POST', url: '/api/v1/scripts', headers, payload: { name: 'Unsupported', source, inputs: {}, props: {} } })).statusCode).toBe(422);
    }
  });
});
