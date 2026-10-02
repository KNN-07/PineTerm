import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { AlertCommand, AlertDefinition, AlertEvent, AlertPayload, Bar, ScriptRevision } from '../../packages/contracts/src/index.js';
import type { FixtureTransport } from '../../tests/fixtures/market.js';

/** Exercises the actual HTTP app and isolated pinned Pine runner, never a fake Pine or production Telegram host. */
export async function runAlertsScenario(url: string, headers: Record<string, string>, fixture: FixtureTransport, advanceClock: (value: number) => void, restart: () => Promise<void>, idle: () => Promise<void>): Promise<void> {
  const { 'Content-Type': _contentType, ...plainHeaders } = headers;
  const market = { provider: 'coinbase' as const, symbol: 'BTC-USD' };
  const base = Math.ceil(fixture.clock() / 60000) * 60000 + 60000;
  const candle = (index: number, close: number): Bar => ({ time: base + index * 60000, open: close, high: close, low: close, close, volume: 1 });
  const bars = [candle(0, 10), candle(1, 10)]; fixture.series.set('1', bars);
  advanceClock(base + 60000); fixture.quote = { market, price: '10', observedAt: fixture.clock(), status: 'live', changePercent: null };
  const secret = randomBytes(32).toString('hex');
  const received: Array<{ payload: AlertPayload; body: string; signature: string; timestamp: string }> = [];
  let failuresRemaining = 1;
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const timestamp = String(request.headers['x-pineterm-timestamp']);
    const signature = String(request.headers['x-pineterm-signature']);
    const expected = 'sha256=' + createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
    if (signature !== expected) { response.writeHead(401).end('Invalid HMAC'); return; }
    received.push({ payload: JSON.parse(body) as AlertPayload, body, signature, timestamp });
    response.writeHead(failuresRemaining-- > 0 ? 500 : 200).end('Recorded real raw bytes');
  });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
  const request = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    const response = await fetch(url + '/api/v1' + path, { method, headers: body === undefined ? plainHeaders : headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
    return text ? JSON.parse(text) as unknown : undefined;
  };
  const create = async (body: AlertCommand): Promise<AlertDefinition> => {
    const result = await request('/alerts', 'POST', body) as { alert: AlertDefinition }; await idle(); return result.alert;
  };
  const history = async (id: string): Promise<AlertEvent[]> => (await request('/alert-events?alertId=' + id) as { events: AlertEvent[] }).events;
  const close = async (index: number, value: number): Promise<void> => {
    bars[index] = candle(index, value); bars[index + 1] = candle(index + 1, value);
    advanceClock(base + (index + 1) * 60000);
    fixture.emit('1', { kind: 'close', bar: bars[index], receivedAt: fixture.clock() }); await idle();
  };
  try {
    const webhook = await request('/webhooks', 'POST', { name: 'Explicit local signed protocol receiver', url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/alerts`, secret }) as { webhook: { id: string } };
    const publicConfig = await request('/webhooks/' + webhook.webhook.id);
    assert.equal(JSON.stringify(publicConfig).includes(secret), false);
    const body: AlertCommand = { name: 'Browser-closed crossing above 11', market, timeframe: '1', mode: 'bar-close', frequency: 'once_per_bar', enabled: true, condition: { kind: 'price', operator: 'crosses_above', price: '11' }, destinations: [{ kind: 'webhook', id: webhook.webhook.id }] };
    await request('/integrations/notifications', 'PUT', { paused: true });
    const alert = await create(body); assert.deepEqual(await history(alert.id), []);
    await close(1, 12); await close(2, 13);
    const persisted = await history(alert.id); assert.equal(persisted.length, 1); assert.equal(persisted[0].kind, 'signal'); assert.equal(persisted[0].occurredAt, base + 120000); assert.equal(persisted[0].deliveries[0].state, 'pending'); assert.equal(received.length, 0);
    const stableId = persisted[0].eventId;
    await restart(); await idle();
    assert.equal((await history(alert.id))[0].eventId, stableId); assert.equal((await history(alert.id)).filter(event => event.kind === 'signal').length, 1); assert.equal(received.length, 0);
    await request('/integrations/notifications', 'PUT', { paused: false }); await idle();
    assert.equal(received.length, 1); assert.equal(received[0].payload.eventId, stableId); assert.equal((await history(alert.id))[0].deliveries[0].state, 'pending');
    advanceClock(fixture.clock() + 5000); await idle();
    const delivered = (await history(alert.id))[0]; assert.equal(delivered.deliveries[0].state, 'delivered'); assert.equal(delivered.deliveries[0].attempts, 2); assert.equal(received.length, 2); assert.equal(received[1].payload.eventId, stableId); assert.equal(received[0].body, received[1].body);

    const source = '//@version=6\nindicator("Immutable server rising close")\nminimum = input.int(1, "Minimum rise")\nrising = close > close[1] and close - close[1] >= minimum\nalertcondition(rising, "Rising close", "Real Pine rising close")\nif rising\n    alert("Real Pine alert() rising close", alert.freq_all)';
    const saved = await request('/scripts', 'POST', { name: 'Real alert smoke immutable revision', source, inputs: {}, props: {} }) as { script: { id: string; revision: number }; revision: ScriptRevision };
    const pineBody: AlertCommand = { ...body, name: 'Real named Pine rising close', condition: { kind: 'pine', eventType: 'alertcondition', title: 'Rising close' }, scriptRevisionId: saved.revision.id, inputs: { minimum: 1 }, warmupFrom: base };
    const pineAlert = await create(pineBody);
    const functionAlert = await create({ ...pineBody, name: 'Real Pine alert() selection', condition: { kind: 'pine', eventType: 'alert' } });
    const mixedAlert = await create({ ...pineBody, name: 'Same-close mixed group', condition: { kind: 'group', operator: 'all', conditions: [{ kind: 'price', operator: 'above', price: '11' }, { kind: 'pine', eventType: 'alertcondition', title: 'Rising close' }] } });
    assert.deepEqual(await history(pineAlert.id), []); assert.deepEqual(await history(functionAlert.id), []); assert.deepEqual(await history(mixedAlert.id), []);
    const edited = await request('/scripts/' + saved.script.id, 'PUT', { revision: saved.script.revision, name: 'Changed library source cannot mutate armed alerts', source: source.replace('close > close[1]', 'close < close[1]'), inputs: {}, props: {} }) as { revision: ScriptRevision };
    assert.notEqual(edited.revision.id, saved.revision.id);
    await close(3, 14);
    for (const armed of [pineAlert, functionAlert, mixedAlert]) {
      const signals = (await history(armed.id)).filter(event => event.kind === 'signal'); assert.equal(signals.length, 1); assert.equal(signals[0].scriptRevisionId, saved.revision.id); assert.equal(signals[0].occurredAt, base + 240000); assert.equal(signals[0].deliveries[0].state, 'delivered');
      assert.equal((await request('/alerts/' + armed.id) as { alert: AlertDefinition }).alert.warmupFrom, base);
    }
    const invalid = await fetch(url + '/api/v1/alerts', { method: 'POST', headers, body: JSON.stringify({ ...pineBody, mode: 'quote' }) }); assert.equal(invalid.status, 422);
    const nested = await fetch(url + '/api/v1/alerts', { method: 'POST', headers, body: JSON.stringify({ ...body, condition: { kind: 'group', operator: 'all', conditions: [{ kind: 'group', operator: 'any', conditions: [body.condition] }] } }) }); assert.equal(nested.status, 400);
    const beforeTest = (await request('/alerts/' + pineAlert.id) as { alert: AlertDefinition }).alert.watermark;
    const testEvent = await request('/alerts/' + pineAlert.id + '/test', 'POST') as { event: AlertEvent }; await idle(); assert.equal(testEvent.event.kind, 'test'); assert.match(testEvent.event.message, /TEST/);
    assert.equal((await request('/alerts/' + pineAlert.id) as { alert: AlertDefinition }).alert.watermark, beforeTest);
    assert.ok(received.some(item => item.payload.eventId === testEvent.event.eventId && item.payload.message.includes('TEST')));

    const beforeOutage = (await history(pineAlert.id)).filter(event => event.kind === 'signal').length;
    const requestsBeforeOutage = received.length;
    fixture.emit('1', { kind: 'status', status: 'stale', message: 'Explicit deterministic outage', receivedAt: fixture.clock() }); await idle();
    for (let i = 4; i <= 7; i++) bars[i] = candle(i, 14 + i);
    advanceClock(base + 7 * 60000);
    await restart(); await idle();
    const recovered = await history(pineAlert.id); assert.equal(recovered.filter(event => event.kind === 'signal').length, beforeOutage); assert.ok(recovered.some(event => event.kind === 'missed' && event.missed!.count === 3)); assert.equal(received.length, requestsBeforeOutage);
    await close(7, 22); assert.equal((await history(pineAlert.id)).filter(event => event.kind === 'signal').length, beforeOutage + 1);
    console.log(`alerts: real HTTP/browser-independent 10→12→13 one signal; paused durable event restart same ${stableId}; local actual-byte HMAC 500→200 retry2; pinned Docker Pine alert()/named/mixed no warmup dispatch; immutable source edit unchanged; 3 missed outage intervals no stale dispatch; fresh resume and labelled test. Local protocol proof only; real Telegram/HTTPS credentials not supplied.`);
  } finally { receiver.closeAllConnections(); await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve())); }
}
