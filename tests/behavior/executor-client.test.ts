import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { DriverRequest, ExecutorRecord, LiveIntent } from '@pineterm/contracts';
import { buildApp } from '../../apps/server/src/app.js';
import { loadConfig } from '../../apps/server/src/config.js';
import { FinanceClient } from '../../examples/api-client/src/index.js';
import { ExecutorClient } from '../../examples/executor-client/src/index.js';
import { FixtureTransport, FIXTURE_START } from '../fixtures/market.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const market = { provider: 'coinbase' as const, symbol: 'BTC-USD' };
const driverPath = resolve('tests/fixtures/recording-executor-driver.mjs');
interface Recording { label: string; submissions: Array<{ clientOrderId: string }>; commands: Array<{ clientOrderId: string; command: string; stage: string }>; orders: Record<string, { request: DriverRequest }> }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pineterm-executor-client-'));
  let now = FIXTURE_START + 360000;
  const clock = () => now;
  const coinbase = new FixtureTransport('coinbase', clock); coinbase.quote.price = '10';
  const config = loadConfig({ PINETERM_ADMIN_PASSWORD: 'executor-client-test-password', PINETERM_SESSION_SECRET: randomBytes(48).toString('base64'), PINETERM_SECRET_KEY: randomBytes(32).toString('base64'), PINETERM_DATA_DIR: join(directory, 'server'), PINETERM_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' });
  const app = await buildApp({ config, providers: { coinbase, binance: new FixtureTransport('binance', clock) }, clock });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: { origin: config.publicOrigin }, payload: { password: config.adminPassword } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], origin: config.publicOrigin, 'x-csrf-token': login.json().csrfToken };
  const registered = await app.inject({ method: 'POST', url: '/api/v1/executors', headers, payload: { name: 'LOCAL TEST ONLY recording driver', enabled: true } });
  expect(registered.statusCode).toBe(201);
  const executor = registered.json().executor as ExecutorRecord;
  const key = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers, payload: { name: 'recording driver only', scopes: ['executor:claim', 'executor:report'], executorId: executor.id } });
  expect(key.statusCode).toBe(201); const token = key.json().token as string;
  const policy = (await app.inject({ url: '/api/v1/execution-policy', headers })).json();
  const enabled = await app.inject({ method: 'PUT', url: '/api/v1/execution-policy', headers, payload: { revision: policy.revision, enabled: true, allowlist: [{ market, sides: ['buy', 'sell'] }], quoteLimits: [{ quoteCurrency: 'USD', perOrderNotional: '100', rolling24hNotional: '200' }], maxPending: 2, maxDeviationBps: '100' } });
  expect(enabled.statusCode).toBe(200);
  const statePath = join(directory, 'client', 'state.sqlite'), recordingPath = join(directory, 'driver.json');
  const clients: ExecutorClient[] = [];
  cleanups.push(async () => { for (const client of clients) await client.close(); });
  return {
    app, url, executor, token, directory, statePath, recordingPath,
    client: (mode = 'filled', extra: string[] = [], clientUrl = url, timeoutMs = 10000) => {
      const client = new ExecutorClient({ api: new FinanceClient({ url: clientUrl, token }), executorId: executor.id, driver: process.execPath, driverArgs: [driverPath, '--state', recordingPath, '--mode', mode, '--price', '10', ...extra], statePath, timeoutMs }); clients.push(client); return client;
    },
    create: async (expiresAhead = 60000) => {
      const response = await app.inject({ method: 'POST', url: '/api/v1/order-intents', headers: { ...headers, 'idempotency-key': randomBytes(16).toString('hex') }, payload: { executorId: executor.id, market, side: 'buy', type: 'market', quantity: '1', expiresAt: now + expiresAhead } });
      expect(response.statusCode).toBe(202); return response.json().intent as LiveIntent;
    },
    get: async (id: string) => (await app.inject({ url: '/api/v1/order-intents/' + id, headers })).json().intent as LiveIntent,
    recording: async () => JSON.parse(await readFile(recordingPath, 'utf8')) as Recording,
    advance: (ms: number) => { now += ms; coinbase.quote.observedAt = now; },
    kill: async () => {
      const current = (await app.inject({ url: '/api/v1/execution-policy', headers })).json();
      const disabled = await app.inject({ method: 'PUT', url: '/api/v1/execution-policy', headers, payload: { revision: current.revision, enabled: false } }); expect(disabled.statusCode).toBe(200);
    },
  };
}

/** A real HTTP proxy forwards mutations to Fastify then drops one response after commit. */
async function droppingProxy(upstream: string, suffix: string) {
  let dropped = false;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string' && !['host', 'connection', 'content-length'].includes(key)) headers[key] = value;
      const body = Buffer.concat(chunks);
      const result = await fetch(upstream + request.url, { method: request.method, headers, ...(body.length ? { body } : {}) });
      const bytes = Buffer.from(await result.arrayBuffer());
      if (!dropped && request.url?.endsWith(suffix)) { dropped = true; response.destroy(); return; }
      response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(bytes);
    } catch { response.destroy(); }
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, '127.0.0.1', listening.resolve); await listening.promise;
  cleanups.push(async () => {
    server.closeAllConnections();
    const closing = Promise.withResolvers<void>(); server.close(error => error ? closing.reject(error) : closing.resolve()); await closing.promise;
  });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No proxy address.');
  return 'http://127.0.0.1:' + address.port;
}

describe('operator executable handoff, not exchange execution', () => {
  it('refuses a missing driver before claiming and the CLI ships no default broker', async () => {
    const f = await fixture(), intent = await f.create();
    expect(() => new ExecutorClient({ api: new FinanceClient({ url: f.url, token: f.token }), executorId: f.executor.id, driver: '', statePath: f.statePath })).toThrow(/operator-specified/);
    const env = { ...process.env, PINETERM_EXECUTOR_URL: f.url, PINETERM_EXECUTOR_TOKEN: f.token, PINETERM_EXECUTOR_ID: f.executor.id, PINETERM_EXECUTOR_STATE: f.statePath };
    delete (env as NodeJS.ProcessEnv).PINETERM_EXECUTOR_DRIVER;
    const child = spawn(process.execPath, ['--import', 'tsx', 'examples/executor-client/src/cli.ts', '--once'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const { promise, resolve } = Promise.withResolvers<number | null>(); child.once('exit', resolve);
    expect(await promise).toBe(1); expect(stderr).not.toContain(f.token); expect((await f.get(intent.id)).state).toBe('pending');
  });
  it('refuses a recording driver in sandbox verification mode before any submission', async () => {
    const f = await fixture(), intent = await f.create();
    const client = new ExecutorClient({ api: new FinanceClient({ url: f.url, token: f.token }), executorId: f.executor.id, driver: process.execPath, driverArgs: [driverPath, '--state', f.recordingPath, '--price', '10'], statePath: f.statePath, requireSandbox: true });
    try {
      expect((await client.cycle()).state).toBe('unknown');
      expect((await f.recording()).submissions).toEqual([]);
      expect((await f.get(intent.id)).risk.pendingCapacity).toBe(true);
    } finally { await client.close(); }
  });
  it('runs the standalone --once CLI against HTTP and preserves one placement over repeated process launches', async () => {
    const f = await fixture(), intent = await f.create();
    const env = { ...process.env, PINETERM_EXECUTOR_URL: f.url, PINETERM_EXECUTOR_TOKEN: f.token, PINETERM_EXECUTOR_ID: f.executor.id, PINETERM_EXECUTOR_STATE: f.statePath, PINETERM_EXECUTOR_DRIVER: process.execPath, PINETERM_EXECUTOR_DRIVER_ARGS: JSON.stringify([driverPath, '--state', f.recordingPath, '--mode', 'filled', '--price', '10']) };
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'examples/executor-client/src/cli.ts', '--once'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      const finished = Promise.withResolvers<number | null>(); child.once('exit', finished.resolve);
      expect(await finished.promise).toBe(0); expect(output).not.toContain(f.token);
    }
    expect((await f.get(intent.id)).state).toBe('filled'); expect((await f.recording()).submissions).toHaveLength(1);
  }, 10000);
  it('fills through an actual child process, retains protected state and does not submit again after restart', async () => {
    const f = await fixture(), intent = await f.create(), first = f.client();
    expect(await first.cycle()).toMatchObject({ intentId: intent.id, state: 'filled', unresolved: false });
    await first.close(); const restarted = f.client(); await restarted.cycle();
    const record = await f.recording(); expect(record.submissions).toEqual([{ clientOrderId: intent.id, market, side: 'buy', protectedCap: '10.1', protectedFloor: '9.9' }]);
    expect((await f.get(intent.id)).filledQuantity).toBe('1'); expect((await f.get(intent.id)).reports).toHaveLength(1);
    expect((await stat(f.statePath)).mode & 0o077).toBe(0); expect((await stat(join(f.directory, 'client'))).mode & 0o077).toBe(0);
    expect(record.label).toContain('NO EXCHANGE CONNECTION');
  });
  it('repairs a committed report with a dropped response by resending the same durable report, with one fill', async () => {
    const f = await fixture(), proxy = await droppingProxy(f.url, '/reports'), intent = await f.create(), first = f.client('filled', [], proxy);
    expect((await first.cycle()).unresolved).toBe(true); expect((await f.get(intent.id)).state).toBe('filled');
    await first.close(); const restarted = f.client('filled', [], proxy); await restarted.cycle();
    const persisted = await f.get(intent.id); expect(persisted.reports).toHaveLength(1); expect(persisted.filledQuantity).toBe('1'); expect((await f.recording()).submissions).toHaveLength(1);
  });
  it('recovers a dropped claim response using status only, holds confirmed absence until the original deadline', async () => {
    const f = await fixture(), proxy = await droppingProxy(f.url, '/claim'), intent = await f.create(), first = f.client('filled', [], proxy);
    await expect(first.cycle()).rejects.toThrow(); await first.close();
    const restarted = f.client('filled', [], proxy);
    expect((await restarted.cycle()).state).toBe('unknown'); expect((await f.recording()).submissions).toEqual([]);
    f.advance(31000); expect((await restarted.cycle()).state).toBe('unknown');
    expect((await f.get(intent.id)).risk.pendingCapacity).toBe(true);
    f.advance(30001); expect((await restarted.cycle()).state).toBe('expired');
    const record = await f.recording(); expect(record.submissions).toEqual([]); expect(record.commands.every(command => command.command === 'status' && command.stage === 'reconcile')).toBe(true);
    expect((await f.get(intent.id)).risk.pendingCapacity).toBe(false);
  });
  it('keeps risk reserved when a recovered absent lookup is not authoritative even after the deadline', async () => {
    const f = await fixture(), proxy = await droppingProxy(f.url, '/claim'), intent = await f.create(), first = f.client('filled', [], proxy);
    await expect(first.cycle()).rejects.toThrow(); await first.close();
    f.advance(61000); const recovered = f.client('filled', ['--absence-confirmed', 'false'], proxy);
    expect((await recovered.cycle()).state).toBe('unknown'); expect((await f.get(intent.id)).risk.pendingCapacity).toBe(true); expect((await f.recording()).submissions).toEqual([]);
    await recovered.close(); const confirmed = f.client('filled', [], proxy); expect((await confirmed.cycle()).state).toBe('expired');
  });
  it('never redispatches an ambiguous submit and reconciles its actual recorded outcome after restarting', async () => {
    const f = await fixture(), intent = await f.create(), first = f.client('ambiguous');
    expect((await first.cycle()).state).toBe('unknown'); await first.close();
    const restarted = f.client('ambiguous'); expect((await restarted.cycle()).state).toBe('filled');
    const record = await f.recording(); expect(record.submissions).toHaveLength(1); expect(record.commands.filter(command => command.command === 'submit')).toHaveLength(1); expect((await f.get(intent.id)).filledQuantity).toBe('1');
  });
  it('processes kill-switch cancellation even while claims are disabled and waits for a driver report', async () => {
    const f = await fixture(), intent = await f.create(), client = f.client('acknowledged');
    expect((await client.cycle()).state).toBe('acknowledged'); await f.kill();
    const requested = await f.get(intent.id); expect(requested.state).toBe('acknowledged'); expect(requested.cancelRequested).toBe(true);
    expect((await client.cycle()).state).toBe('cancelled');
    expect((await f.recording()).commands.filter(command => command.command === 'cancel')).toHaveLength(1); expect((await f.recording()).submissions).toHaveLength(1);
    expect((await f.get(intent.id)).reports.at(-1)?.status).toBe('cancelled');
  });
  it.each([
    { name: 'off-band venue price', extra: ['--price', '11'] },
    { name: 'stale venue quote', extra: ['--quote-age-ms', '31001'] },
    { name: 'invalid venue price precision', extra: ['--price', '10.001'] },
    { name: 'different venue quote', extra: ['--quote-provider', 'binance', '--quote-symbol', 'BTCUSDT'] },
  ])('rejects $name before placement', async ({ extra }) => {
    const f = await fixture(), intent = await f.create(), client = f.client('filled', extra);
    expect((await client.cycle()).state).toBe('rejected'); expect((await f.recording()).submissions).toEqual([]); expect((await f.get(intent.id)).filledQuantity).toBe('0');
  });
  it('uses server-anchored monotonic elapsed time to expire a slow preflight before placement', async () => {
    const f = await fixture(), intent = await f.create(2000), client = f.client('filled', ['--preflight-delay-ms', '2200']);
    expect((await client.cycle()).state).toBe('expired'); expect((await f.recording()).submissions).toEqual([]); expect((await f.get(intent.id)).risk.pendingCapacity).toBe(false);
  }, 10000);
  it('bounds a hung submit, preserves ambiguity on restart, and never retries placement', async () => {
    const f = await fixture(), intent = await f.create(), client = f.client('filled', ['--submit-delay-ms', '5000'], f.url, 1000);
    const started = performance.now(); expect((await client.cycle()).state).toBe('unknown'); expect(performance.now() - started).toBeLessThan(4000);
    await client.close(); const restarted = f.client(); expect((await restarted.cycle()).state).toBe('unknown');
    expect((await f.recording()).submissions).toEqual([]); f.advance(31000); expect((await restarted.cycle()).state).toBe('unknown');
    expect((await f.get(intent.id)).risk.pendingCapacity).toBe(true);
    f.advance(30001); expect((await restarted.cycle()).state).toBe('expired'); expect((await f.get(intent.id)).filledQuantity).toBe('0');
  }, 10000);
  it('close waits for the driver and its owned descendant to be stopped before delayed placement can occur', async () => {
    const f = await fixture(); await f.create();
    const marker = join(f.directory, 'owned-descendant-placement');
    const client = f.client('filled', ['--submit-delay-ms', '5000', '--fork-marker', marker]);
    const running = client.cycle().catch(() => null);
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await stat(marker + '.started'); started = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await delay(25);
    }
    expect(started).toBe(true);
    const beforeClose = performance.now(); await Promise.all([client.close(), client.close()]); await running;
    expect(performance.now() - beforeClose).toBeLessThan(2000);
    await delay(2200); await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const recovered = f.client(); expect((await recovered.cycle()).state).toBe('unknown'); expect((await f.recording()).submissions).toEqual([]);
  }, 10000);
});
