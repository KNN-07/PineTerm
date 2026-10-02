import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { loadConfig } from '../../apps/server/src/config.js';
import { FIXTURE_START, FixtureTransport } from '../fixtures/market.js';
import type { AlertCommand, AlertDefinition, AlertEvent, Bar } from '../../packages/contracts/src/index.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
const market = { provider: 'coinbase' as const, symbol: 'BTC-USD' };
const command: AlertCommand = { name: 'Crossing', market, timeframe: '1', mode: 'bar-close', frequency: 'once_per_bar', enabled: true, condition: { kind: 'price', operator: 'crosses_above', price: '11' }, destinations: [] };
function candle(index: number, close: number): Bar { return { time: FIXTURE_START + index * 60000, open: close, high: close, low: close, close, volume: 1 }; }
async function alertApp() {
  const directory = await mkdtemp(join(tmpdir(), 'pineterm-alerts-'));
  let now = FIXTURE_START + 60000; const clock = () => now;
  const fixture = new FixtureTransport('coinbase', clock);
  fixture.series.set('1', [candle(0, 10), candle(1, 10)]);
  fixture.quote = { market, price: '10', observedAt: now, status: 'live', changePercent: null };
  const config = loadConfig({ PINETERM_ADMIN_PASSWORD: 'alerts-test-password', PINETERM_SESSION_SECRET: randomBytes(48).toString('base64'), PINETERM_SECRET_KEY: randomBytes(32).toString('base64'), PINETERM_DATA_DIR: directory, PINETERM_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' });
  let app = await buildApp({ config, clock, providers: { coinbase: fixture, binance: new FixtureTransport('binance', clock) } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: { origin: config.publicOrigin }, payload: { password: config.adminPassword } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], origin: config.publicOrigin, 'x-csrf-token': String(login.json().csrfToken) };
  cleanup.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    get app() { return app; }, fixture, headers,
    async create(body: AlertCommand = command): Promise<AlertDefinition> {
      const response = await app.inject({ method: 'POST', url: '/api/v1/alerts', headers, payload: body });
      expect(response.statusCode, response.body).toBe(201); await app.services.alerts.idle();
      return app.services.alerts.get(response.json().alert.id);
    },
    async closeBar(index: number, close: number): Promise<void> {
      const bars = fixture.series.get('1')!; bars[index] = candle(index, close); bars[index + 1] = candle(index + 1, close);
      now = FIXTURE_START + (index + 1) * 60000;
      fixture.emit('1', { kind: 'close', bar: bars[index], receivedAt: now }); await app.services.alerts.idle();
    },
    async quote(price: string, age = 0): Promise<void> {
      now += 1000; fixture.emit('1', { kind: 'quote', quote: { market, price, observedAt: now - age, status: age ? 'stale' : 'live', changePercent: null } }); await app.services.alerts.idle();
    },
    async restart(outageBars = 0): Promise<void> {
      await app.close();
      if (outageBars) {
        const bars = fixture.series.get('1')!;
        const end = bars.length + outageBars;
        for (let i = bars.length; i < end; i++) bars.push(candle(i, 20));
        now = bars.at(-1)!.time;
      }
      fixture.quote = { ...fixture.quote, observedAt: now };
      app = await buildApp({ config, clock, providers: { coinbase: fixture, binance: new FixtureTransport('binance', clock) } }); await app.services.alerts.idle();
    },
    events(id: string): AlertEvent[] { return app.services.alerts.listEvents(id); },
  };
}

describe('durable server alert boundaries', () => {
  it('arms without firing and serializes browser-independent 10→12→13 crossing exactly once', async () => {
    const fixture = await alertApp(); const alert = await fixture.create();
    expect(alert.watermark).toBe(FIXTURE_START); expect(fixture.events(alert.id)).toEqual([]);
    await fixture.closeBar(1, 12); await fixture.closeBar(2, 13);
    expect(fixture.events(alert.id).map(event => [event.kind, event.occurredAt])).toEqual([['signal', FIXTURE_START + 120000]]);
    fixture.fixture.emit('1', { kind: 'close', bar: candle(1, 12), receivedAt: FIXTURE_START + 180000 }); await fixture.app.services.alerts.idle();
    expect(fixture.events(alert.id)).toHaveLength(1);
    await fixture.restart(); expect(fixture.events(alert.id)).toHaveLength(1);
    expect(fixture.app.services.alerts.get(alert.id).watermark).toBe(FIXTURE_START + 120000);
  });
  it('compares tiny finite raw candle prices without scientific-notation parsing failures', async () => {
    const fixture = await alertApp();
    const alert = await fixture.create({ ...command, condition: { kind: 'price', operator: 'crosses_below', price: '0.00000002' } });
    await fixture.closeBar(1, 0.00000001);
    expect(fixture.events(alert.id).map(event => event.kind)).toEqual(['signal']);
    expect(fixture.app.services.alerts.get(alert.id).pausedReason).toBeNull();
  });
  it('fires quote above only on false→true and deduplicates the timeframe bucket', async () => {
    const fixture = await alertApp(); const alert = await fixture.create({ ...command, mode: 'quote', condition: { kind: 'price', operator: 'above', price: '11' } });
    await fixture.quote('12'); await fixture.quote('13'); await fixture.quote('10'); await fixture.quote('12');
    expect(fixture.events(alert.id)).toHaveLength(1);
    await fixture.closeBar(2, 10); await fixture.quote('10'); await fixture.quote('12');
    expect(fixture.events(alert.id)).toHaveLength(2);
  });
  it('stops once alerts and archive deletion retains audit while stopping future evaluation', async () => {
    const fixture = await alertApp(); const once = await fixture.create({ ...command, frequency: 'once' });
    await fixture.closeBar(1, 12); expect(fixture.app.services.alerts.get(once.id).enabled).toBe(false);
    const live = await fixture.create({ ...command, condition: { kind: 'price', operator: 'above', price: '11' } });
    await fixture.closeBar(2, 13); expect(fixture.events(live.id)).toHaveLength(1);
    const deleted = await fixture.app.inject({ method: 'DELETE', url: '/api/v1/alerts/' + live.id, headers: fixture.headers }); expect(deleted.statusCode).toBe(204);
    await fixture.closeBar(3, 14); expect(fixture.events(live.id)).toHaveLength(1); expect(fixture.events(once.id)).toHaveLength(1);
    expect((await fixture.app.inject({ url: '/api/v1/alerts/' + live.id, headers: fixture.headers })).statusCode).toBe(404);
    const history = await fixture.app.inject({ url: '/api/v1/alert-events?alertId=' + live.id, headers: fixture.headers }); expect(history.statusCode).toBe(200); expect(history.json().events[0].kind).toBe('signal');
  });
  it('rebuilds outages as missed history without dispatching stale crossing signals', async () => {
    const fixture = await alertApp(); const alert = await fixture.create();
    await fixture.restart(3);
    const history = fixture.events(alert.id); expect(history.map(event => event.kind)).toEqual(['missed']); expect(history[0].missed?.count).toBeGreaterThan(0); expect(history[0].deliveries).toEqual([]);
    const watermark = fixture.app.services.alerts.get(alert.id).watermark!;
    const next = (watermark - FIXTURE_START) / 60000 + 1;
    await fixture.closeBar(next, 10); await fixture.closeBar(next + 1, 12);
    expect(fixture.events(alert.id).filter(event => event.kind === 'signal')).toHaveLength(1);
  });
  it('shows provider failure instead of treating cached history as live, then reconnects without catch-up', async () => {
    const fixture = await alertApp(); const alert = await fixture.create();
    fixture.fixture.failure = new Error('Fixture provider unavailable'); fixture.fixture.emit('1', { kind: 'status', status: 'stale', message: 'Disconnected venue', receivedAt: fixture.fixture.clock() }); await fixture.app.services.alerts.idle();
    expect(fixture.app.services.alerts.get(alert.id).pausedReason).toContain('MARKET_UNAVAILABLE');
    await fixture.closeBar(1, 12); expect(fixture.events(alert.id)).toEqual([]); expect(fixture.app.services.alerts.get(alert.id).pausedReason).not.toBeNull();
    fixture.fixture.failure = null; fixture.fixture.emit('1', { kind: 'status', status: 'live', message: 'Reconnect', receivedAt: fixture.fixture.clock() });
    await fixture.app.services.alerts.idle();
    expect(fixture.events(alert.id).filter(event => event.kind === 'signal')).toEqual([]);
  });
  it('evaluates all/any price groups on the same confirmed close', async () => {
    const fixture = await alertApp();
    const all = await fixture.create({ ...command, condition: { kind: 'group', operator: 'all', conditions: [command.condition as { kind: 'price'; operator: 'crosses_above'; price: string }, { kind: 'price', operator: 'below', price: '13' }] } });
    const any = await fixture.create({ ...command, condition: { kind: 'group', operator: 'any', conditions: [{ kind: 'price', operator: 'above', price: '13' }, { kind: 'price', operator: 'crosses_above', price: '11' }] } });
    await fixture.closeBar(1, 12); await fixture.closeBar(2, 14);
    expect(fixture.events(all.id)).toHaveLength(1); expect(fixture.events(any.id)).toHaveLength(2);
  });
  it('rejects unsupported/ambiguous groups, replay origin and unauthorized mutations', async () => {
    const fixture = await alertApp();
    const invalid = [
      { ...command, condition: { kind: 'price', operator: 'above', price: '0' } },
      { ...command, condition: { kind: 'group', operator: 'all', conditions: [] } },
      { ...command, condition: { kind: 'group', operator: 'all', conditions: [command.condition, { kind: 'group', operator: 'any', conditions: [command.condition] }] } },
      { ...command, mode: 'quote', condition: { kind: 'pine', eventType: 'alert' }, scriptRevisionId: '00000000-0000-4000-8000-000000000001' },
      { ...command, condition: { kind: 'pine', eventType: 'alertcondition' } },
      { ...command, market: { provider: 'csv', symbol: '00000000-0000-4000-8000-000000000001' } },
      { ...command, replaySessionId: '00000000-0000-4000-8000-000000000001' },
    ];
    for (const payload of invalid) expect((await fixture.app.inject({ method: 'POST', url: '/api/v1/alerts', headers: fixture.headers, payload })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await fixture.app.inject({ method: 'POST', url: '/api/v1/alerts', payload: command })).statusCode).toBe(401);
    expect((await fixture.app.inject({ method: 'POST', url: '/api/v1/alerts', headers: { cookie: fixture.headers.cookie, origin: fixture.headers.origin }, payload: command })).statusCode).toBe(403);
  });
  it('re-arms with CAS and never evaluates an old paused revision', async () => {
    const fixture = await alertApp(); const alert = await fixture.create();
    fixture.fixture.emit('1', { kind: 'close', bar: candle(1, 12), receivedAt: FIXTURE_START + 120000 });
    const pause = await fixture.app.inject({ method: 'PUT', url: '/api/v1/alerts/' + alert.id, headers: fixture.headers, payload: { ...command, enabled: false, revision: alert.revision } }); expect(pause.statusCode).toBe(200);
    await fixture.app.services.alerts.idle(); const afterPause = fixture.events(alert.id).length;
    await fixture.closeBar(1, 12); expect(fixture.events(alert.id)).toHaveLength(afterPause);
    const stale = await fixture.app.inject({ method: 'PUT', url: '/api/v1/alerts/' + alert.id, headers: fixture.headers, payload: { ...command, revision: alert.revision } }); expect(stale.statusCode).toBe(409);
    const resumed = await fixture.app.inject({ method: 'PUT', url: '/api/v1/alerts/' + alert.id, headers: fixture.headers, payload: { ...command, revision: pause.json().alert.revision } }); expect(resumed.statusCode).toBe(200);
    await fixture.app.services.alerts.idle(); expect(fixture.events(alert.id)).toHaveLength(afterPause); expect(resumed.json().alert.watermark).toBe(FIXTURE_START + 60000);
  });
  it('pins the actual Pine source/inputs and discards warm-up alertcondition events', async () => {
    const fixture = await alertApp();
    const source = '//@version=6\nindicator("Rising close")\nminimum=input.int(1,"Minimum")\nalertcondition(close > close[1] and close-close[1] >= minimum,"Rising","Rising close signal")';
    const saved = fixture.app.services.scripts.create({ name: 'Pinned rising alert', source, inputs: {}, props: {} });
    const alert = await fixture.create({ ...command, condition: { kind: 'pine', eventType: 'alertcondition', title: 'Rising' }, scriptRevisionId: saved.revision.id, inputs: { minimum: 1 }, warmupFrom: FIXTURE_START });
    expect(alert.enabled).toBe(true); expect(alert.pausedReason).toBeNull();
    fixture.app.services.scripts.update(saved.script.id, { name: 'Changed head', revision: saved.script.revision, source: source.replace('close > close[1]', 'close < close[1]'), inputs: {}, props: {} });
    await fixture.closeBar(1, 12);
    expect(fixture.events(alert.id).map(event => [event.message, event.scriptRevisionId])).toEqual([['Rising close signal', saved.revision.id]]);
    await fixture.restart();
    expect(fixture.events(alert.id).filter(event => event.kind === 'signal')).toHaveLength(1);
    expect(fixture.app.services.alerts.get(alert.id).warmupFrom).toBe(FIXTURE_START);
    await fixture.closeBar(2, 13);
    expect(fixture.events(alert.id).filter(event => event.kind === 'signal')).toHaveLength(2);
  }, 60000);
  it('emits one configured event per bar despite multiple real Pine freq_all occurrences', async () => {
    const fixture = await alertApp();
    const saved = fixture.app.services.scripts.create({ name: 'Multiple Pine occurrences', source: '//@version=6\nindicator("Multiple occurrences")\nif close > close[1]\n    alert("First real occurrence",alert.freq_all)\n    alert("Second real occurrence",alert.freq_all)', inputs: {}, props: {} });
    const alert = await fixture.create({ ...command, condition: { kind: 'pine', eventType: 'alert' }, scriptRevisionId: saved.revision.id, warmupFrom: FIXTURE_START });
    await fixture.closeBar(1, 12);
    const first = fixture.events(alert.id); expect(first.map(event => event.message)).toEqual(['First real occurrence']);
    await fixture.restart();
    fixture.fixture.emit('1', { kind: 'close', bar: candle(1, 12), receivedAt: fixture.fixture.clock() }); await fixture.app.services.alerts.idle();
    expect(fixture.events(alert.id).map(event => event.eventId)).toEqual(first.map(event => event.eventId));
    await fixture.closeBar(2, 13);
    expect(fixture.events(alert.id).map(event => [event.message, event.occurredAt])).toEqual([['First real occurrence', FIXTURE_START + 180000], ['First real occurrence', FIXTURE_START + 120000]]);
  }, 60000);
  it('aborts an in-flight real Pine evaluation when its definition is paused', async () => {
    const fixture = await alertApp();
    const saved = fixture.app.services.scripts.create({ name: 'In-flight signal', source: '//@version=6\nindicator("In-flight")\nif close > close[1]\n    alert("Must not deliver after pause",alert.freq_all)', inputs: {}, props: {} });
    const body: AlertCommand = { ...command, condition: { kind: 'pine', eventType: 'alert' }, scriptRevisionId: saved.revision.id, warmupFrom: FIXTURE_START };
    const alert = await fixture.create(body);
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const run = fixture.app.services.pine.runSnapshot.bind(fixture.app.services.pine);
    fixture.app.services.pine.runSnapshot = async (request, signal) => { entered.resolve(); await release.promise; return run(request, signal); };
    const evaluation = fixture.closeBar(1, 12);
    try {
      await entered.promise;
      const paused = await fixture.app.inject({ method: 'PUT', url: '/api/v1/alerts/' + alert.id, headers: fixture.headers, payload: { ...body, enabled: false, revision: alert.revision } });
      expect(paused.statusCode).toBe(200); release.resolve(); await evaluation;
      expect(fixture.events(alert.id)).toEqual([]); expect(fixture.app.services.alerts.get(alert.id).enabled).toBe(false);
    } finally { release.resolve(); await evaluation; fixture.app.services.pine.runSnapshot = run; }
  }, 30000);
  it('exposes invalid isolated Pine as a paused actionable configuration error', async () => {
    const fixture = await alertApp();
    const saved = fixture.app.services.scripts.create({ name: 'Invalid Pine', source: '//@version=6\nindicator("Invalid")\nplot(unknown_symbol)', inputs: {}, props: {} });
    const alert = await fixture.create({ ...command, condition: { kind: 'pine', eventType: 'alert' }, scriptRevisionId: saved.revision.id, warmupFrom: FIXTURE_START });
    expect(alert.enabled).toBe(false); expect(alert.pausedReason).not.toBeNull(); expect(fixture.events(alert.id)).toEqual([]);
  }, 20000);
});
