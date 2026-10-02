import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { loadConfig } from '../../apps/server/src/config.js';
import { FIXTURE_START, FixtureTransport } from '../fixtures/market.js';
import type { AlertCommand, AlertEvent, ExecutionPolicy, ExecutorLease, ExecutorRecord, LiveIntent, OrderIntentRequest, SubmitExecutorReport } from '../../packages/contracts/src/index.js';

const market = { provider: 'coinbase' as const, symbol: 'BTC-USD' };
const binanceMarket = { provider: 'binance' as const, symbol: 'BTCUSDT' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function executionApp() {
  const directory = await mkdtemp(join(tmpdir(), 'pineterm-executor-'));
  let now = FIXTURE_START + 60000; const clock = () => now;
  const coinbase = new FixtureTransport('coinbase', clock); const binance = new FixtureTransport('binance', clock);
  coinbase.quote = { market, price: '10', observedAt: now, status: 'live', changePercent: null };
  binance.quote = { market: binanceMarket, price: '10', observedAt: now, status: 'live', changePercent: null };
  const config = loadConfig({ PINETERM_ADMIN_PASSWORD: 'execution-test-password', PINETERM_SESSION_SECRET: randomBytes(48).toString('base64'), PINETERM_SECRET_KEY: randomBytes(32).toString('base64'), PINETERM_DATA_DIR: directory, PINETERM_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' });
  let app = await buildApp({ config, clock, providers: { coinbase, binance } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: { origin: config.publicOrigin }, payload: { password: config.adminPassword } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], origin: config.publicOrigin, 'x-csrf-token': String(login.json().csrfToken) };
  cleanup.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const created = await app.inject({ method: 'POST', url: '/api/v1/executors', headers, payload: { name: 'Explicit protocol test executor', enabled: true } });
  expect(created.statusCode, created.body).toBe(201); const executor = created.json().executor as ExecutorRecord;
  const key = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers, payload: { name: 'Bound protocol key', scopes: ['executor:claim','executor:report'], executorId: executor.id } });
  expect(key.statusCode, key.body).toBe(201); const executorHeaders = { authorization: 'Bearer ' + String(key.json().token) };
  return {
    get app() { return app; }, headers, executorHeaders, executor, coinbase, binance, clock,
    async login(): Promise<void> {
      const session = await app.inject({ method: 'POST', url: '/api/v1/session', headers: { origin: config.publicOrigin }, payload: { password: config.adminPassword } });
      expect(session.statusCode).toBe(200); headers.cookie = String(session.headers['set-cookie']).split(';')[0]; headers['x-csrf-token'] = String(session.json().csrfToken);
    },
    body(overrides: Partial<OrderIntentRequest> = {}): OrderIntentRequest { return { executorId: executor.id, market, side: 'buy', type: 'market', quantity: '1', expiresAt: now + 60000, ...overrides }; },
    async enable(overrides: Partial<ExecutionPolicy> = {}): Promise<ExecutionPolicy> {
      const policy = app.services.execution.getPolicy();
      const response = await app.inject({ method: 'PUT', url: '/api/v1/execution-policy', headers, payload: { enabled: true, revision: policy.revision, allowlist: [{ market, sides: ['buy','sell'] }, { market: binanceMarket, sides: ['buy','sell'] }], quoteLimits: [{ quoteCurrency: 'USD', perOrderNotional: '100', rolling24hNotional: '200' }, { quoteCurrency: 'USDT', perOrderNotional: '100', rolling24hNotional: '200' }], maxPending: 1, maxDeviationBps: '100', ...overrides } });
      expect(response.statusCode, response.body).toBe(200); return response.json() as ExecutionPolicy;
    },
    async intent(body: OrderIntentRequest, key: string = randomUUID()): Promise<LiveIntent> {
      const response = await app.inject({ method: 'POST', url: '/api/v1/order-intents', headers: { ...headers, 'idempotency-key': key }, payload: body });
      expect(response.statusCode, response.body).toBe(202); return response.json().intent as LiveIntent;
    },
    async claim(): Promise<ExecutorLease> {
      const response = await app.inject({ method: 'POST', url: '/api/v1/executors/' + executor.id + '/claim', headers: executorHeaders });
      expect(response.statusCode, response.body).toBe(200); expect(response.json().claim).not.toBeNull(); return response.json().claim as ExecutorLease;
    },
    report(lease: ExecutorLease, report: Omit<SubmitExecutorReport, 'leaseToken'>) { return app.inject({ method: 'POST', url: '/api/v1/order-intents/' + lease.intent.id + '/reports', headers: executorHeaders, payload: { ...report, leaseToken: lease.leaseToken } }); },
    async advance(milliseconds: number): Promise<void> { now += milliseconds; await app.services.execution.idle(); },
    async fresh(price = '10'): Promise<void> {
      coinbase.quote = { market, price, observedAt: now, status: 'live', changePercent: null }; binance.quote = { market: binanceMarket, price, observedAt: now, status: 'live', changePercent: null };
      coinbase.emit('1', { kind: 'quote', quote: coinbase.quote });
      await app.services.alerts.idle(); await app.services.execution.idle();
    },
    async restart(): Promise<void> { await app.close(); app = await buildApp({ config, clock, providers: { coinbase, binance } }); await app.services.execution.idle(); },
  };
}

describe('durable scoped live handoff safety', () => {
  it('starts disabled without unlimited limits and rejects non-admin policy/CRUD and read-only trading', async () => {
    const h = await executionApp();
    expect(h.app.services.execution.getPolicy()).toMatchObject({ enabled: false, allowlist: [], quoteLimits: [], maxPending: null, maxDeviationBps: null });
    const disabled = await h.app.inject({ method: 'POST', url: '/api/v1/order-intents', headers: { ...h.headers, 'idempotency-key': 'disabled' }, payload: h.body() });
    expect(disabled.statusCode).toBe(403); expect(h.app.services.execution.listIntents()).toEqual([]);
    const readKey = await h.app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: h.headers, payload: { name: 'Market read only', scopes: ['market:read'] } });
    const headers = { authorization: 'Bearer ' + String(readKey.json().token), 'idempotency-key': 'readonly' };
    for (const [url, method, payload] of [ ['/api/v1/order-intents','POST',h.body()], ['/api/v1/execution-policy','PUT',{ enabled: false, revision: 1 }], ['/api/v1/executors','POST',{ name: 'No', enabled: true }] ] as const) {
      expect((await h.app.inject({ method, url, headers, payload })).statusCode).toBe(403);
    }
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/order-intents', headers: { 'idempotency-key': 'unauth' }, payload: h.body() })).statusCode).toBe(401);
  });
  it('claims once with protected worst-case risk, fills once and returns the original duplicate report response without leaking tokens', async () => {
    const h = await executionApp(); await h.enable(); const body = h.body(); const intent = await h.intent(body, 'stable');
    expect(intent.risk).toMatchObject({ requestedNotional: '10.1', retainedNotional: '10.1', pendingCapacity: true });
    expect((await h.intent(body, 'stable')).id).toBe(intent.id);
    const conflict = await h.app.inject({ method: 'POST', url: '/api/v1/order-intents', headers: { ...h.headers, 'idempotency-key': 'stable' }, payload: { ...body, quantity: '2' } }); expect(conflict.statusCode).toBe(409);
    const lease = await h.claim(); expect(lease.clientOrderId).toBe(intent.id); expect(lease).toMatchObject({ minExecutionPrice: '9.9', maxExecutionPrice: '10.1', quantityStep: '1', tickSize: '0.01' });
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/executors/' + h.executor.id + '/claim', headers: h.executorHeaders })).json().claim).toBeNull();
    const report = { reportId: 'filled', status: 'filled' as const, externalOrderId: 'external-order', fills: [{ externalFillId: 'fill-1', quantity: '1', price: '10', fee: '-0.01', currency: 'USD', time: h.clock() }] };
    const first = await h.report(lease, report); expect(first.statusCode, first.body).toBe(200); expect(first.json().intent.state).toBe('filled');
    await h.advance(61000); await h.app.services.execution.updatePolicy({ enabled: false, revision: h.app.services.execution.getPolicy().revision });
    const duplicate = await h.report(lease, report); expect(duplicate.statusCode).toBe(200); expect(duplicate.json()).toEqual(first.json());
    expect(h.app.services.execution.reportedPositions()).toEqual([{ executorId: h.executor.id, market, quoteCurrency: 'USD', netQuantity: '1', boughtQuantity: '1', soldQuantity: '0', boughtNotional: '10', soldNotional: '0', fees: { USD: '-0.01' }, lastFillAt: report.fills[0].time }]);
    expect(h.app.services.execution.usage()).toEqual([{ quoteCurrency: 'USD', rolling24hNotional: '10.1', unresolvedNotional: '0', pendingIntents: 0 }]);
    const sqlite = h.app.db.prepare<[string], { encrypted_lease_token: string; lease_token_hash: string }>('SELECT encrypted_lease_token,lease_token_hash FROM live_intents WHERE id=?').get(intent.id)!;
    expect(sqlite.encrypted_lease_token).not.toContain(lease.leaseToken); expect(sqlite.lease_token_hash).not.toBe(lease.leaseToken);
    const records = h.app.db.prepare<[], { payload_json: string }>('SELECT payload_json FROM executor_reports').all(); expect(JSON.stringify(records)).not.toContain(lease.leaseToken);
    for (const url of ['/api/v1/order-intents','/api/v1/order-intents/' + intent.id,'/api/v1/execution-audit','/api/v1/executors']) {
      const view = await h.app.inject({ url, headers: h.headers }); expect(view.body).not.toContain(lease.leaseToken); expect(view.body).not.toContain(sqlite.encrypted_lease_token);
    }
  });
  it('rejects oversized, expired, historical, replay/backtest, client-price and precision-invalid commands and unsupported query fields', async () => {
    const h = await executionApp(); await h.enable();
    for (const [changes, status] of [ [{ quantity: '11' },422], [{ quantity: '0.1' },422], [{ expiresAt: h.clock() },422], [{ expiresAt: h.clock() + 60001 },422], [{ market: { provider: 'csv', symbol: randomUUID() } },422], [{ origin: 'replay' },400], [{ origin: 'backtest' },400], [{ sourceEventId: randomUUID() },400], [{ price: '1' },400], [{ quantity: '1.0' },400], [{ type: 'limit', limitPrice: '10.001' },422], [{ type: 'market', limitPrice: '10' },400], [{ type: 'limit' },400] ] as const) {
      const response = await h.app.inject({ method: 'POST', url: '/api/v1/order-intents', headers: { ...h.headers, 'idempotency-key': randomUUID() }, payload: { ...h.body(), ...changes } }); expect(response.statusCode, response.body).toBe(status);
    }
    expect((await h.app.inject({ url: '/api/v1/order-intents?origin=replay', headers: h.headers })).statusCode).toBe(400);
    await h.advance(30001);
    const stale = await h.app.inject({ method: 'POST', url: '/api/v1/order-intents', headers: { ...h.headers, 'idempotency-key': 'stale' }, payload: h.body() }); expect(stale.statusCode).toBe(503);
    expect(h.app.services.execution.listIntents()).toEqual([]);
  });
  it('rejects zero intent amounts and zero reported fills while accepting a genuine no-fill acknowledgement', async () => {
    const h = await executionApp(); await h.enable();
    for (const changes of [{ quantity: '0' }, { type: 'limit', limitPrice: '0' }] as const) {
      const invalid = await h.app.inject({ method: 'POST', url: '/api/v1/order-intents', headers: { ...h.headers, 'idempotency-key': randomUUID() }, payload: { ...h.body(), ...changes } });
      expect(invalid.statusCode, invalid.body).toBe(422);
    }
    await h.intent(h.body()); const lease = await h.claim();
    const fill = { externalFillId: 'zero-boundary', quantity: '1', price: '10', fee: '0', currency: 'USD', time: h.clock() };
    for (const changes of [{ quantity: '0' }, { price: '0' }]) {
      const invalid = await h.report(lease, { reportId: randomUUID(), status: 'partially_filled', fills: [{ ...fill, ...changes }] });
      expect(invalid.statusCode, invalid.body).toBe(422);
    }
    const acknowledged = await h.report(lease, { reportId: 'valid-no-fill', status: 'acknowledged', externalOrderId: 'actual-ack', fills: [] });
    expect(acknowledged.statusCode, acknowledged.body).toBe(200);
    expect(acknowledged.json().intent).toMatchObject({ state: 'acknowledged', filledQuantity: '0', risk: { pendingCapacity: true, retainedNotional: '10.1' } });
    expect(h.app.services.execution.reportedPositions()).toEqual([]);
  });
  it('requires executor-bound keys for claim/control/report even when an admin has the original token', async () => {
    const h = await executionApp(); await h.enable(); const intent = await h.intent(h.body());
    for (const [method, suffix] of [['POST','claim'],['GET','control']] as const) expect((await h.app.inject({ method, url: '/api/v1/executors/' + h.executor.id + '/' + suffix, headers: h.headers })).statusCode).toBe(403);
    const other = h.app.services.execution.createExecutor({ name: 'Foreign executor', enabled: true });
    const otherKey = await h.app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: h.headers, payload: { name: 'Foreign key', scopes: ['executor:claim','executor:report'], executorId: other.id } });
    const foreign = { authorization: 'Bearer ' + String(otherKey.json().token) };
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/executors/' + h.executor.id + '/claim', headers: foreign })).statusCode).toBe(403);
    const lease = await h.claim(); const payload = { leaseToken: lease.leaseToken, reportId: 'ack', status: 'acknowledged', fills: [] };
    for (const headers of [h.headers, foreign]) expect((await h.app.inject({ method: 'POST', url: '/api/v1/order-intents/' + intent.id + '/reports', headers, payload })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/order-intents/' + intent.id + '/reports', headers: h.executorHeaders, payload: { ...payload, leaseToken: 'foreign-token' } })).statusCode).toBe(403);
    expect(h.app.services.execution.getIntent(intent.id).state).toBe('claimed');
  });
  it('reserves pending capacity atomically across quote currencies without equating USD and USDT', async () => {
    const h = await executionApp(); await h.enable();
    const results = await Promise.all([h.body(),h.body({ market: binanceMarket })].map(payload => h.app.inject({ method: 'POST', url: '/api/v1/order-intents', headers: { ...h.headers, 'idempotency-key': randomUUID() }, payload })));
    expect(results.map(result => result.statusCode).sort()).toEqual([202,429]);
    const accepted = results.find(result => result.statusCode === 202)!.json().intent as LiveIntent;
    h.app.services.execution.cancelIntent(accepted.id); expect(h.app.services.execution.usage().every(value => value.pendingIntents === 0 && value.rolling24hNotional === '0')).toBe(true);
    await h.enable({ maxPending: 2, quoteLimits: [{ quoteCurrency: 'USD', perOrderNotional: '10.1', rolling24hNotional: '10.1' }, { quoteCurrency: 'USDT', perOrderNotional: '10.1', rolling24hNotional: '10.1' }] });
    const usd = await h.intent(h.body()); const usdt = await h.intent(h.body({ market: binanceMarket }));
    expect(h.app.services.execution.usage()).toEqual([{ quoteCurrency: 'USD', rolling24hNotional: '10.1', unresolvedNotional: '10.1', pendingIntents: 1 }, { quoteCurrency: 'USDT', rolling24hNotional: '10.1', unresolvedNotional: '10.1', pendingIntents: 1 }]);
    h.app.services.execution.cancelIntent(usd.id); h.app.services.execution.cancelIntent(usdt.id);
  });
  it('enforces rolling submitted reservations under concurrent creates and counts a protected market cap rather than reference notional', async () => {
    const h = await executionApp(); await h.enable({ maxPending: 2, quoteLimits: [{ quoteCurrency: 'USD', perOrderNotional: '20', rolling24hNotional: '20' }, { quoteCurrency: 'USDT', perOrderNotional: '20', rolling24hNotional: '20' }] });
    const results = await Promise.all([1,2].map(() => h.app.inject({ method: 'POST', url: '/api/v1/order-intents', headers: { ...h.headers, 'idempotency-key': randomUUID() }, payload: h.body() })));
    expect(results.map(value => value.statusCode).sort()).toEqual([202,422]); expect(h.app.services.execution.usage()[0].rolling24hNotional).toBe('10.1');
  });
  it('holds limit risk at the greater reference/limit, retains full partial reservation, then releases only proven unexecuted quantity', async () => {
    const h = await executionApp(); await h.enable();
    const intent = await h.intent(h.body({ type: 'limit', quantity: '4', limitPrice: '12' })); expect(intent.risk.requestedNotional).toBe('48');
    const lease = await h.claim();
    const partial = { reportId: 'partial', status: 'partially_filled' as const, externalOrderId: 'limit-order', fills: [{ externalFillId: 'one', quantity: '1', price: '10', fee: '0.1', currency: 'USDT', time: h.clock() }] };
    expect((await h.report(lease, partial)).json().intent.risk).toMatchObject({ retainedNotional: '48', pendingCapacity: true });
    expect((await h.report(lease, { reportId: 'backwards', status: 'acknowledged', fills: [] })).statusCode).toBe(409);
    expect((await h.report(lease, { reportId: 'partial-duplicate-fill', status: 'partially_filled', fills: partial.fills })).json().intent.filledQuantity).toBe('1');
    const cancelled = await h.report(lease, { reportId: 'cancel', status: 'cancelled', fills: [] }); expect(cancelled.statusCode).toBe(200); expect(cancelled.json().intent.risk).toMatchObject({ retainedNotional: '12', pendingCapacity: false });
    expect(h.app.services.execution.reportedPositions()[0].fees).toEqual({ USDT: '0.1' });
    expect((await h.report(lease, partial)).json().intent.state).toBe('partially_filled');
    expect(h.app.services.execution.getIntent(intent.id).state).toBe('cancelled');
  });
  it('accounts favorable sell fills without rejecting reality or understating notional reserved for the unexecuted remainder', async () => {
    const h = await executionApp(); await h.enable(); await h.intent(h.body({ side: 'sell', quantity: '2' })); const lease = await h.claim();
    const partial = await h.report(lease, { reportId: 'favorable-sale', status: 'partially_filled', fills: [{ externalFillId: 'sale-one', quantity: '1', price: '11', fee: '0', currency: 'USD', time: h.clock() }] });
    expect(partial.statusCode).toBe(200); expect(partial.json().intent.risk).toMatchObject({ requestedNotional: '20.2', retainedNotional: '21.1', pendingCapacity: true });
    const cancelled = await h.report(lease, { reportId: 'sale-cancel', status: 'cancelled', fills: [] }); expect(cancelled.json().intent.risk).toMatchObject({ retainedNotional: '11', pendingCapacity: false });
    expect(h.app.services.execution.reportedPositions()[0]).toMatchObject({ netQuantity: '-1', soldQuantity: '1', soldNotional: '11' });
  });
  it('rejects report/fill conflicts, overfills, inconsistent terminal states and adverse prices but accepts favorable fills', async () => {
    const h = await executionApp(); await h.enable(); await h.intent(h.body({ quantity: '2' })); const lease = await h.claim();
    const fill = { externalFillId: 'one', quantity: '1', price: '9', fee: '0', currency: 'USD', time: h.clock() };
    expect((await h.report(lease, { reportId: 'bad-price', status: 'partially_filled', fills: [{ ...fill, price: '10.11' }] })).statusCode).toBe(422);
    expect((await h.report(lease, { reportId: 'bad-filled', status: 'filled', fills: [fill] })).statusCode).toBe(409);
    const partial = { reportId: 'partial', status: 'partially_filled' as const, fills: [fill] }; expect((await h.report(lease, partial)).statusCode).toBe(200);
    expect((await h.report(lease, { ...partial, status: 'unknown' })).statusCode).toBe(409);
    expect((await h.report(lease, { reportId: 'changed-fill', status: 'partially_filled', fills: [{ ...fill, price: '8' }] })).statusCode).toBe(409);
    expect((await h.report(lease, { reportId: 'overfill', status: 'filled', fills: [{ ...fill, externalFillId: 'overfill', quantity: '2' }] })).statusCode).toBe(409);
    expect((await h.report(lease, { reportId: 'complete', status: 'filled', fills: [{ ...fill, externalFillId: 'two', price: '8' }] })).statusCode).toBe(200);
    expect(h.app.services.execution.reportedPositions()[0]).toMatchObject({ netQuantity: '2', boughtNotional: '17' });
  });
  it('expires only unsubmitted pending intents and keeps claim ambiguity/risk outside 24 hours through restart and late original-token reconciliation', async () => {
    const h = await executionApp(); await h.enable(); const intent = await h.intent(h.body()); const lease = await h.claim();
    await h.advance(30000); expect(h.app.services.execution.getIntent(intent.id).state).toBe('unknown');
    await h.restart(); await h.advance(86400001);
    const control = h.app.services.execution.control(h.executor.id); expect(control.orders[0].leaseToken).toBe(lease.leaseToken); expect(control.orders[0].clientOrderId).toBe(intent.id); expect(control.claimsPausedReason).not.toBeNull();
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/executors/' + h.executor.id + '/claim', headers: h.executorHeaders })).json().claim).toBeNull();
    expect(h.app.services.execution.usage()).toEqual([{ quoteCurrency: 'USD', rolling24hNotional: '10.1', unresolvedNotional: '10.1', pendingIntents: 1 }]);
    await h.login(); await h.fresh(); const blocked = await h.app.inject({ method: 'POST', url: '/api/v1/order-intents', headers: { ...h.headers, 'idempotency-key': 'after-unknown' }, payload: h.body() }); expect(blocked.statusCode).toBe(409);
    const reconciled = await h.report(lease, { reportId: 'late', status: 'cancelled', fills: [] }); expect(reconciled.statusCode).toBe(200); expect(reconciled.json().intent.risk.retainedNotional).toBe('0'); expect(h.app.services.execution.getExecutor(h.executor.id).claimsPausedReason).toBeNull();
    const pending = await h.intent(h.body({ expiresAt: h.clock() + 1000 })); await h.advance(1000); expect(h.app.services.execution.getIntent(pending.id).state).toBe('expired'); expect(h.app.services.execution.getIntent(pending.id).risk.retainedNotional).toBe('0');
  });
  it('marks an interrupted active claim unknown immediately after restart without replacing its original token', async () => {
    const h = await executionApp(); await h.enable(); const intent = await h.intent(h.body()); const lease = await h.claim(); await h.restart();
    expect(h.app.services.execution.getIntent(intent.id).state).toBe('unknown'); expect(h.app.services.execution.control(h.executor.id).orders[0].leaseToken).toBe(lease.leaseToken);
    const late = await h.report(lease, { reportId: 'recovered-ack', status: 'acknowledged', externalOrderId: 'exchange-found', fills: [] }); expect(late.statusCode).toBe(200); expect(late.json().intent.state).toBe('acknowledged');
    await h.advance(60000); expect(h.app.services.execution.getIntent(intent.id).state).toBe('acknowledged');
  });
  it('kills pending immediately but keeps externally acknowledged orders awaiting actual cancellation reports across lease expiry/restart', async () => {
    const h = await executionApp(); await h.enable({ maxPending: 2 }); const accepted = await h.intent(h.body()); const lease = await h.claim();
    expect((await h.report(lease, { reportId: 'ack', status: 'acknowledged', externalOrderId: 'external', fills: [] })).statusCode).toBe(200);
    const pending = await h.intent(h.body()); const policy = h.app.services.execution.getPolicy(); await h.app.services.execution.updatePolicy({ enabled: false, revision: policy.revision });
    expect(h.app.services.execution.getIntent(pending.id)).toMatchObject({ state: 'cancelled', risk: { retainedNotional: '0', pendingCapacity: false } });
    expect(h.app.services.execution.getIntent(accepted.id)).toMatchObject({ state: 'acknowledged', cancelRequested: true });
    await h.advance(61000); await h.restart(); expect(h.app.services.execution.getIntent(accepted.id).state).toBe('acknowledged'); expect(h.app.services.execution.control(h.executor.id).orders[0].intent.cancelRequested).toBe(true);
    expect((await h.report(lease, { reportId: 'cancelled-at-exchange', status: 'cancelled', fills: [] })).json().intent.state).toBe('cancelled');
  });
  it('rechecks changed policy and latest metadata/freshness/risk at claim, rather than trusting acceptance or client price', async () => {
    const h = await executionApp(); await h.enable(); const intent = await h.intent(h.body({ quantity: '5' }));
    await h.enable({ quoteLimits: [{ quoteCurrency: 'USD', perOrderNotional: '40', rolling24hNotional: '200' }, { quoteCurrency: 'USDT', perOrderNotional: '40', rolling24hNotional: '200' }] });
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/executors/' + h.executor.id + '/claim', headers: h.executorHeaders })).json().claim).toBeNull(); expect(h.app.services.execution.getIntent(intent.id).state).toBe('rejected');
    await h.enable(); const next = await h.intent(h.body()); await h.advance(30001);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/executors/' + h.executor.id + '/claim', headers: h.executorHeaders })).json().claim).toBeNull(); expect(h.app.services.execution.getIntent(next.id).state).toBe('pending');
    await h.fresh('10.05'); const latest = await h.claim(); expect(latest.intent.referencePrice).toBe('10'); expect(latest.intent.risk.requestedNotional).toBe('10.1'); expect(latest.maxExecutionPrice).toBe('10.1');
  });
  it('never silently rebases a market intent when a fresh quote leaves its accepted reference band', async () => {
    const h = await executionApp(); await h.enable(); const intent = await h.intent(h.body()); await h.advance(30001); await h.fresh('12');
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/executors/' + h.executor.id + '/claim', headers: h.executorHeaders })).json().claim).toBeNull();
    expect(h.app.services.execution.getIntent(intent.id)).toMatchObject({ referencePrice: '10', maxExecutionPrice: '10.1', state: 'rejected', risk: { retainedNotional: '0', pendingCapacity: false } });
  });
  it('uses CAS for policy/executors and archives without erasing risk reports/audit', async () => {
    const h = await executionApp(); const enabled = await h.enable();
    expect((await h.app.inject({ method: 'PUT', url: '/api/v1/execution-policy', headers: h.headers, payload: { enabled: false, revision: enabled.revision - 1 } })).statusCode).toBe(409);
    expect((await h.app.inject({ method: 'PUT', url: '/api/v1/executors/' + h.executor.id, headers: h.headers, payload: { name: 'stale', enabled: false, revision: h.executor.revision + 1 } })).statusCode).toBe(409);
    const intent = await h.intent(h.body()); const lease = await h.claim();
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/executors/' + h.executor.id, headers: h.headers })).statusCode).toBe(204);
    expect(h.app.services.execution.getIntent(intent.id)).toMatchObject({ state: 'claimed', cancelRequested: true });
    expect((await h.report(lease, { reportId: 'archive-cancel', status: 'cancelled', fills: [] })).statusCode).toBe(200);
    expect(h.app.services.execution.audit().some(entry => entry.type === 'executor_archived' && entry.executorId === h.executor.id)).toBe(true); expect(h.app.services.execution.getIntent(intent.id).reports[0].reportId).toBe('archive-cancel');
  });
  it('stages fixed alert actions while disabled, then executes fresh signals independently of global notification pause and never creates actions for tests', async () => {
    const h = await executionApp();
    const action = { executorId: h.executor.id, market, side: 'buy' as const, type: 'market' as const, quantity: '1' };
    const body: AlertCommand = { name: 'Fixed autonomous action', market, timeframe: '1', mode: 'quote', frequency: 'once_per_bar', enabled: true, condition: { kind: 'price', operator: 'crosses_above', price: '11' }, destinations: [], liveAction: action };
    const created = await h.app.inject({ method: 'POST', url: '/api/v1/alerts', headers: h.headers, payload: body }); expect(created.statusCode, created.body).toBe(201); const id = String(created.json().alert.id); await h.app.services.alerts.idle();
    await h.enable(); await h.app.inject({ method: 'PUT', url: '/api/v1/integrations/notifications', headers: h.headers, payload: { paused: true } });
    await h.advance(1000); await h.fresh('12');
    const events = h.app.services.alerts.listEvents(id); expect(events[0]).toMatchObject({ kind: 'signal', liveAction: { state: 'created' } });
    const intent = h.app.services.execution.getIntent(events[0].liveAction!.intentId!); expect(intent).toMatchObject({ quantity: '1', sourceEventId: events[0].eventId });
    const test = await h.app.inject({ method: 'POST', url: '/api/v1/alerts/' + id + '/test', headers: h.headers }); expect(test.statusCode).toBe(200); await h.app.services.execution.idle();
    expect((test.json().event as AlertEvent).kind).toBe('test'); expect(h.app.services.execution.getAlertAction(String(test.json().event.eventId))).toBeUndefined(); expect(h.app.services.execution.listIntents().map(value => value.id)).toEqual([intent.id]);
  });
  it('binds durable action provenance to signal, queue, unchanged revision and fixed fields, never parses a JSON-looking alert message', async () => {
    const h = await executionApp(); await h.enable({ maxPending: 2 });
    const action = { executorId: h.executor.id, market, side: 'buy' as const, type: 'market' as const, quantity: '1' };
    const body: AlertCommand = { name: 'Stored signal provenance', market, timeframe: '1', mode: 'quote', frequency: 'once', enabled: true, condition: { kind: 'price', operator: 'above', price: '11' }, destinations: [], liveAction: action };
    const created = await h.app.inject({ method: 'POST', url: '/api/v1/alerts', headers: h.headers, payload: body }); expect(created.statusCode).toBe(201); const alertId = String(created.json().alert.id);
    await h.app.services.alerts.idle();
    const eventId = randomUUID();
    const stored = { eventId, alertId, occurredAt: h.clock(), market, timeframe: '1', kind: 'signal', message: '{"quantity":"999","side":"sell","type":"market"}' };
    h.app.db.transaction(() => {
      h.app.db.prepare('INSERT INTO alert_events(id,alert_id,alert_revision,dedupe_key,payload_json,occurred_at,created_at) VALUES (?,?,1,?,?,?,?)').run(eventId, alertId, 'seed:' + eventId, JSON.stringify(stored), h.clock(), h.clock());
      h.app.services.execution.enqueueAlertAction(eventId, action, h.clock());
    }).immediate();
    await h.app.services.execution.idle();
    const result = h.app.services.execution.getAlertAction(eventId)!; expect(result.state).toBe('created'); expect(h.app.services.execution.getIntent(result.intentId!)).toMatchObject({ quantity: '1', side: 'buy', sourceEventId: eventId });
    await expect(h.app.services.execution.createIntent({ ...action, quantity: '999', expiresAt: h.clock() + 60000 }, 'alert:' + eventId, null, eventId)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const invalidId = randomUUID();
    h.app.db.transaction(() => {
      h.app.db.prepare('INSERT INTO alert_events(id,alert_id,alert_revision,dedupe_key,payload_json,occurred_at,created_at) VALUES (?,?,1,?,?,?,?)').run(invalidId, alertId, 'seed:' + invalidId, JSON.stringify({ ...stored, eventId: invalidId }), h.clock(), h.clock());
      h.app.services.execution.enqueueAlertAction(invalidId, action, h.clock());
      h.app.db.prepare('UPDATE alerts SET revision=revision+1 WHERE id=?').run(alertId);
    }).immediate();
    await h.app.services.execution.idle(); expect(h.app.services.execution.getAlertAction(invalidId)).toMatchObject({ state: 'failed', intentId: null, error: { code: 'ALERT_ACTION_INVALIDATED' } });
    await h.restart(); expect(h.app.services.execution.getAlertAction(invalidId)?.state).toBe('failed'); expect(h.app.services.execution.listIntents().map(value => value.id)).toEqual([result.intentId]);
    for (const kind of ['test','missed']) {
      const nonSignal = randomUUID();
      h.app.db.prepare('INSERT INTO alert_events(id,alert_id,alert_revision,dedupe_key,payload_json,occurred_at,created_at) VALUES (?,?,2,?,?,?,?)').run(nonSignal, alertId, 'seed:' + nonSignal, JSON.stringify({ ...stored, eventId: nonSignal, kind }), h.clock(), h.clock());
      await expect(Promise.resolve().then(() => h.app.services.execution.enqueueAlertAction(nonSignal, action, h.clock()))).rejects.toMatchObject({ code: 'ALERT_ACTION_INVALIDATED' });
      expect(h.app.services.execution.getAlertAction(nonSignal)).toBeUndefined();
    }
    const staleId = randomUUID();
    h.app.db.transaction(() => {
      h.app.db.prepare('INSERT INTO alert_events(id,alert_id,alert_revision,dedupe_key,payload_json,occurred_at,created_at) VALUES (?,?,2,?,?,?,?)').run(staleId, alertId, 'seed:' + staleId, JSON.stringify({ ...stored, eventId: staleId }), h.clock(), h.clock());
      h.app.services.execution.enqueueAlertAction(staleId, action, h.clock());
    }).immediate();
    await expect(h.app.services.execution.createIntent({ ...action, expiresAt: h.clock() + 59000 }, 'alert:' + staleId, null, staleId)).rejects.toMatchObject({ code: 'ALERT_ACTION_INVALIDATED' });
    await h.advance(60000); expect(h.app.services.execution.getAlertAction(staleId)).toMatchObject({ state: 'failed', intentId: null, error: { code: 'ALERT_ACTION_STALE' } });
    await h.restart(); expect(h.app.services.execution.getAlertAction(staleId)?.state).toBe('failed');
  });
});
