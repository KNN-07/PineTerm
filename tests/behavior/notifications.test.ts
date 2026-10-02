import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AlertDestination, AlertPayload } from '../../packages/contracts/src/index.js';
import { loadConfig } from '../../apps/server/src/config.js';
import { openDatabase } from '../../apps/server/src/database.js';
import { SecretStore } from '../../apps/server/src/secrets.js';
import { InvalidationHub } from '../../apps/server/src/events.js';
import { NotificationService, type NotificationOptions, type NotificationReadContext } from '../../apps/server/src/notifications/NotificationService.js';
import { isPublicAddress } from '../../apps/server/src/notifications/webhook.js';
import type { TelegramApi, TelegramResponse, TelegramUpdate } from '../../apps/server/src/notifications/telegram.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const START = Date.UTC(2026, 0, 1);
const signingSecret = 'fixture-webhook-secret-never-public';
const botToken = '123456:secret_fixture_bot_token_123456';
const context: NotificationReadContext = { status: () => 'server running', alerts: () => 'armed alert list', positions: async () => 'private portfolio holdings' };
async function notificationFixture(options: NotificationOptions = {}, localHosts: string[] = [], readContext = context) {
  const directory = await mkdtemp(join(tmpdir(), 'pineterm-notifications-'));
  let now = START;
  const clock = () => now;
  const config = loadConfig({ PINETERM_ADMIN_PASSWORD: 'notification-test-password', PINETERM_SESSION_SECRET: randomBytes(48).toString('base64'), PINETERM_SECRET_KEY: randomBytes(32).toString('base64'), PINETERM_DATA_DIR: directory, PINETERM_DEV_WEBHOOK_HOSTS: localHosts.join(',') });
  const db = openDatabase(directory, clock); const secrets = new SecretStore(config.secretKey); const events = new InvalidationHub(db, clock);
  let service = new NotificationService(db, secrets, config, clock, events, options);
  await service.initialise(readContext);
  cleanups.push(async () => { await service.close(); events.close(); secrets.dispose(); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { db, secrets, config, get service() { return service; }, advance: (milliseconds: number) => { now += milliseconds; }, restart: async () => { await service.close(); service = new NotificationService(db, secrets, config, clock, events, options); await service.initialise(readContext); return service; },
    enqueue: (destinations: AlertDestination[], kind: 'signal' | 'test' = 'signal') => {
      const alertId = randomUUID(); const eventId = randomUUID();
      const payload: AlertPayload & { kind: string } = { eventId, alertId, occurredAt: now, market: { provider: 'coinbase', symbol: 'BTC-USD' }, timeframe: '1', message: 'Rising close é “quoted”\nnew line', kind };
      db.transaction(() => {
        db.prepare("INSERT INTO alerts(id,name,revision,provider,symbol,timeframe,mode,frequency,enabled,definition_json,evaluation_state_json,created_at,updated_at) VALUES (?,'fixture',1,'coinbase','BTC-USD','1','bar-close','once_per_bar',1,'{}','{}',?,?)").run(alertId, now, now);
        db.prepare('INSERT INTO alert_events(id,alert_id,alert_revision,dedupe_key,payload_json,occurred_at,created_at) VALUES (?,?,1,?,?,?,?)').run(eventId, alertId, eventId, JSON.stringify(payload), now, now);
        service.enqueue(eventId, destinations, now);
      }).immediate();
      return { alertId, eventId, payload };
    },
  };
}
async function receiver(handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void) {
  const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); handler(request, response, Buffer.concat(chunks)); });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', resolve); await promise;
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected bound fixture receiver.');
  cleanups.push(async () => { server.closeAllConnections(); const stopped = Promise.withResolvers<void>(); server.close(() => stopped.resolve()); await stopped.promise; });
  return `http://receiver.test:${address.port}`;
}

class TelegramProtocolPeer {
  readonly sends: Array<Record<string, unknown>> = [];
  readonly offsets: number[] = [];
  webhookUrl = '';
  sendResult: TelegramResponse = { ok: true, result: { message_id: 1 } };
  failure = false;
  private pending?: { resolve(value: TelegramResponse): void; detach(): void };
  private readonly waiters: Array<{ offset: number; resolve(): void }> = [];
  readonly api: TelegramApi = async (method, body, signal) => {
    if (this.failure) throw new Error(`https://api.telegram.org/bot${botToken}/${method}`);
    if (method === 'getMe') return { ok: true, result: { id: 123456, username: 'PineTermFixtureBot' } };
    if (method === 'getWebhookInfo') return { ok: true, result: { url: this.webhookUrl } };
    if (method === 'sendMessage') { this.sends.push(body); return this.sendResult; }
    this.offsets.push(Number(body.offset));
    for (let index = this.waiters.length - 1; index >= 0; index--) if (Number(body.offset) >= this.waiters[index].offset) { this.waiters[index].resolve(); this.waiters.splice(index, 1); }
    const pending = Promise.withResolvers<TelegramResponse>();
    const abort = () => { this.pending = undefined; pending.resolve({ ok: true, result: [] }); };
    if (signal.aborted) { abort(); return pending.promise; }
    signal.addEventListener('abort', abort, { once: true });
    this.pending = { resolve: pending.resolve, detach: () => signal.removeEventListener('abort', abort) };
    return pending.promise;
  };
  push(updates: TelegramUpdate[]): void {
    if (!this.pending) throw new Error('Expected pending real-shape getUpdates request.');
    const pending = this.pending; this.pending = undefined; pending.detach(); pending.resolve({ ok: true, result: updates });
  }
  async atOffset(offset: number): Promise<void> {
    if (this.offsets.at(-1)! >= offset) return;
    const waiter = Promise.withResolvers<void>(); this.waiters.push({ offset, resolve: waiter.resolve }); await waiter.promise;
  }
}
const telegramSetup = { revision: 0, token: botToken, allowedChatIds: ['42'], allowedUserIds: ['7'], enabled: true };

// These are security/state behavior cases, not evidence of real Telegram credentialed acceptance.
describe('safe signed webhooks and durable outbox', () => {
  it.each(['0.0.0.0', '127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.16.1.2', '192.168.1.1', '192.0.2.3', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::1', '2002:7f00:1::', '64:ff9b::a00:1'])('rejects non-public IPv4/IPv6 destination %s', address => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it('rejects literal/local/DNS mixed answers and revalidates a changed answer before sending', async () => {
    let answers = [{ address: '8.8.8.8', family: 4 }];
    const fixture = await notificationFixture({ resolveWebhook: async () => answers });
    for (const url of ['https://127.0.0.1/', 'https://[::ffff:127.0.0.1]/', 'http://example.com/', 'https://user:password@example.com/', 'https://example.com/#fragment']) await expect(fixture.service.createWebhook({ name: 'Unsafe', url, secret: signingSecret })).rejects.toMatchObject({ statusCode: expect.any(Number) });
    answers = [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }];
    await expect(fixture.service.createWebhook({ name: 'Mixed DNS', url: 'https://rebind.test/', secret: signingSecret })).rejects.toMatchObject({ code: 'UNSAFE_WEBHOOK_ADDRESS' });
    answers = [{ address: '8.8.8.8', family: 4 }];
    const webhook = await fixture.service.createWebhook({ name: 'Validated', url: 'https://rebind.test/', secret: signingSecret });
    answers = [{ address: '127.0.0.1', family: 4 }];
    const result = await fixture.service.testWebhook(webhook.id);
    expect(result).toMatchObject({ delivered: false, status: null }); expect(result.message).toContain('public addresses');
  });
  it('pins one validated DNS answer and never follows a receiver redirect', async () => {
    const paths: string[] = []; let resolutions = 0;
    const url = await receiver((request, response) => { paths.push(request.url!); response.writeHead(302, { location: '/forbidden' }); response.end(); });
    const fixture = await notificationFixture({ resolveWebhook: async () => { resolutions++; return [{ address: '127.0.0.1', family: 4 }]; } }, ['receiver.test']);
    const webhook = await fixture.service.createWebhook({ name: 'Redirect', url: url + '/redirect', secret: signingSecret });
    expect(await fixture.service.testWebhook(webhook.id)).toMatchObject({ delivered: false, status: 302 });
    expect(paths).toEqual(['/redirect']); expect(resolutions).toBe(2);
  });
  it('signs actual raw UTF-8 bytes, retries after 5s and keeps the same ID after interrupted-sending restart', async () => {
    const observed: Array<{ bytes: Buffer; signature: string; timestamp: string }> = [];
    const url = await receiver((request, response, bytes) => { observed.push({ bytes, signature: String(request.headers['x-pineterm-signature']), timestamp: String(request.headers['x-pineterm-timestamp']) }); response.writeHead(observed.length === 1 ? 500 : 200); response.end(); });
    const fixture = await notificationFixture({ resolveWebhook: async () => [{ address: '127.0.0.1', family: 4 }] }, ['receiver.test']);
    const webhook = await fixture.service.createWebhook({ name: 'Signed retry', url, secret: signingSecret });
    const event = fixture.enqueue([{ kind: 'webhook', id: webhook.id }]);
    await fixture.service.idle();
    expect(fixture.service.listDeliveries(event.eventId)[0]).toMatchObject({ state: 'pending', attempts: 1, nextAttemptAt: START + 5000, lastStatus: 500 });
    fixture.advance(4999); await fixture.service.idle(); expect(observed).toHaveLength(1);
    fixture.advance(1);
    // Simulate process termination after a durable claim but before delivery acknowledgement.
    fixture.db.prepare("UPDATE alert_deliveries SET state='sending' WHERE event_id=?").run(event.eventId);
    await fixture.restart(); await fixture.service.idle();
    expect(fixture.service.listDeliveries(event.eventId)[0]).toMatchObject({ state: 'delivered', attempts: 2, lastStatus: 200 });
    expect(observed.map(item => JSON.parse(item.bytes.toString('utf8')).eventId)).toEqual([event.eventId, event.eventId]);
    for (const item of observed) expect(item.signature).toBe('sha256=' + createHmac('sha256', signingSecret).update(item.timestamp).update('.').update(item.bytes).digest('hex'));
    expect(JSON.stringify(fixture.service.getWebhook(webhook.id))).not.toContain(signingSecret);
    const encrypted = fixture.db.prepare<[string], { encrypted_secret: string }>('SELECT encrypted_secret FROM webhooks WHERE id=?').get(webhook.id)!;
    expect(encrypted.encrypted_secret).not.toContain(signingSecret);
    expect(() => fixture.secrets.decrypt(encrypted.encrypted_secret, 'webhook:another:secret')).toThrow();
  });
  it('honors 429 Retry-After, caps retries at 5/30/120s, and makes ordinary 4xx terminal', async () => {
    let status = 429; let calls = 0;
    const url = await receiver((_request, response) => { calls++; response.writeHead(status, { 'retry-after': '60' }); response.end(); });
    const fixture = await notificationFixture({ resolveWebhook: async () => [{ address: '127.0.0.1', family: 4 }] }, ['receiver.test']);
    const webhook = await fixture.service.createWebhook({ name: 'Retry states', url, secret: signingSecret });
    const event = fixture.enqueue([{ kind: 'webhook', id: webhook.id }]); await fixture.service.idle();
    expect(fixture.service.listDeliveries(event.eventId)[0].nextAttemptAt).toBe(START + 60000);
    fixture.advance(59999); await fixture.service.idle(); expect(calls).toBe(1);
    status = 500; fixture.advance(1); await fixture.service.idle();
    expect(fixture.service.listDeliveries(event.eventId)[0].nextAttemptAt).toBe(START + 90000);
    fixture.advance(30000); await fixture.service.idle();
    expect(fixture.service.listDeliveries(event.eventId)[0].nextAttemptAt).toBe(START + 210000);
    fixture.advance(120000); await fixture.service.idle();
    expect(fixture.service.listDeliveries(event.eventId)[0]).toMatchObject({ state: 'failed', attempts: 4 });
    status = 401; const unauthorized = fixture.enqueue([{ kind: 'webhook', id: webhook.id }]); await fixture.service.idle();
    expect(fixture.service.listDeliveries(unauthorized.eventId)[0]).toMatchObject({ state: 'failed', attempts: 1, lastStatus: 401 });
  });
  it('persists global pause and fails deleted pending destinations without removing audit', async () => {
    let calls = 0;
    const url = await receiver((_request, response) => { calls++; response.end(); });
    const fixture = await notificationFixture({ resolveWebhook: async () => [{ address: '127.0.0.1', family: 4 }] }, ['receiver.test']);
    const webhook = await fixture.service.createWebhook({ name: 'Paused', url, secret: signingSecret });
    fixture.service.setNotificationsPaused(true);
    const event = fixture.enqueue([{ kind: 'webhook', id: webhook.id }]); await fixture.service.idle(); await fixture.restart(); await fixture.service.idle();
    expect(fixture.service.getStatus().paused).toBe(true); expect(calls).toBe(0);
    fixture.service.deleteWebhook(webhook.id); fixture.service.setNotificationsPaused(false); await fixture.service.idle();
    expect(fixture.service.listDeliveries(event.eventId)[0]).toMatchObject({ state: 'failed', attempts: 0, lastError: 'Webhook destination was deleted.' }); expect(calls).toBe(0);
    expect(fixture.db.prepare<[string], { enabled: number }>('SELECT enabled FROM alerts WHERE id=?').get(event.alertId)!.enabled).toBe(1);
  });
  it('rejects new explicit webhook tests while channel reconfiguration awaits an interrupted poll', async () => {
    let receiverCalls = 0;
    const url = await receiver((_request, response) => { receiverCalls++; response.end(); });
    const peer = new TelegramProtocolPeer();
    const polling = Promise.withResolvers<void>();
    const interrupted = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<TelegramResponse>();
    const fixture = await notificationFixture({
      resolveWebhook: async () => [{ address: '127.0.0.1', family: 4 }],
      telegramApi: async (method, body, signal) => {
        if (method !== 'getUpdates') return peer.api(method, body, signal);
        polling.resolve();
        signal.addEventListener('abort', () => interrupted.resolve(), { once: true });
        return settled.promise;
      },
    }, ['receiver.test']);
    const webhook = await fixture.service.createWebhook({ name: 'Concurrent test', url, secret: signingSecret });
    const configured = await fixture.service.updateTelegram(telegramSetup);
    await polling.promise;
    const changing = fixture.service.updateTelegram({ ...telegramSetup, token: undefined, revision: configured.revision, enabled: false });
    await interrupted.promise;
    try {
      await expect(fixture.service.testWebhook(webhook.id)).rejects.toMatchObject({ statusCode: 409, code: 'CONFIGURATION_CHANGING' });
      expect(receiverCalls).toBe(0);
    } finally {
      settled.resolve({ ok: true, result: [] });
      await changing;
    }
    expect((await fixture.service.testWebhook(webhook.id)).delivered).toBe(true);
    expect(receiverCalls).toBe(1);
  });
  it('does not resurrect a deleted destination when an in-flight receiver acknowledges late', async () => {
    const accepted = Promise.withResolvers<ServerResponse>();
    const url = await receiver((_request, response) => accepted.resolve(response));
    const fixture = await notificationFixture({ resolveWebhook: async () => [{ address: '127.0.0.1', family: 4 }] }, ['receiver.test']);
    const webhook = await fixture.service.createWebhook({ name: 'Delete race', url, secret: signingSecret }); const event = fixture.enqueue([{ kind: 'webhook', id: webhook.id }]);
    fixture.service.wake(); const response = await accepted.promise;
    fixture.service.deleteWebhook(webhook.id); response.end('already received'); await fixture.service.idle();
    expect(fixture.service.listDeliveries(event.eventId)[0]).toMatchObject({ state: 'failed', lastError: 'Webhook destination was deleted.' });
  });
});

describe('dedicated Telegram bot protocol and command authorization', () => {
  it('requires both allowed chat and user, persists offset, records only acknowledged commands and never trades', async () => {
    const peer = new TelegramProtocolPeer(); let portfolioReads = 0;
    const fixture = await notificationFixture({ telegramApi: peer.api }, [], { ...context, positions: async () => { portfolioReads++; return 'private portfolio holdings'; } });
    expect(await fixture.service.updateTelegram(telegramSetup)).toMatchObject({ configured: true, status: 'connected' });
    peer.push([
      { update_id: 1, message: { text: '/positions', chat: { id: 999 }, from: { id: 7 } } },
      { update_id: 2, message: { text: '/positions', chat: { id: 42 }, from: { id: 999 } } },
      { update_id: 3, message: { text: '/buy 1 BTC', chat: { id: 42 }, from: { id: 7 } } },
      { update_id: 4, message: { text: '/positions@OtherBot', chat: { id: 42 }, from: { id: 7 } } },
    ]); await peer.atOffset(5);
    expect(portfolioReads).toBe(0); expect(peer.sends).toEqual([]); expect(fixture.service.getTelegram().lastCommand).toBeUndefined();
    peer.push([{ update_id: 5, message: { text: '/positions', chat: { id: 42 }, from: { id: 7 } } }, { update_id: 5, message: { text: '/positions', chat: { id: 42 }, from: { id: 7 } } }, { update_id: 6, message: { text: '/pause_alerts', chat: { id: 42 }, from: { id: 7 } } }]); await peer.atOffset(7);
    expect(portfolioReads).toBe(1); expect(peer.sends[0]).toEqual({ chat_id: '42', text: 'private portfolio holdings' });
    expect(fixture.service.getTelegram()).toMatchObject({ updateOffset: 7, lastCommand: { name: '/pause_alerts', updateId: 6, observedAt: START } });
    expect(fixture.service.getStatus().paused).toBe(true);
    await fixture.restart(); expect(peer.offsets.at(-1)).toBe(7); expect(portfolioReads).toBe(1);
    peer.sendResult = { ok: false, error_code: 403 };
    peer.push([{ update_id: 7, message: { text: '/status', chat: { id: 42 }, from: { id: 7 } } }]); await peer.atOffset(8);
    expect(fixture.service.getTelegram().lastCommand?.name).toBe('/pause_alerts');
  });
  it('shows existing webhook conflict without deleting it or sending any configured test', async () => {
    const peer = new TelegramProtocolPeer(); peer.webhookUrl = 'https://other-application.example/webhook';
    const fixture = await notificationFixture({ telegramApi: peer.api });
    const config = await fixture.service.updateTelegram(telegramSetup);
    expect(config).toMatchObject({ configured: true, status: 'webhook-conflict' }); expect(config.reason).toContain('dedicated bot');
    expect((await fixture.service.testTelegram()).delivered).toBe(false); expect(peer.sends).toEqual([]); expect(peer.offsets).toEqual([]);
  });
  it('encrypts and redacts token failures, supports token-preserving revision CAS and explicit plain-text test', async () => {
    const peer = new TelegramProtocolPeer(); const fixture = await notificationFixture({ telegramApi: peer.api });
    const configured = await fixture.service.updateTelegram(telegramSetup);
    await expect(fixture.service.updateTelegram({ ...telegramSetup, token: undefined })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const updated = await fixture.service.updateTelegram({ ...telegramSetup, revision: configured.revision, token: undefined });
    expect(updated.revision).toBe(2);
    fixture.service.setNotificationsPaused(true);
    const test = await fixture.service.testTelegram(); expect(test.delivered).toBe(true);
    expect(peer.sends.at(-1)).toMatchObject({ chat_id: '42' }); expect(peer.sends.at(-1)!.text).toContain('[PineTerm TEST]'); expect(peer.sends.at(-1)!.text).toContain(test.eventId); expect(peer.sends.at(-1)).not.toHaveProperty('parse_mode');
    expect(JSON.stringify(updated)).not.toContain(botToken);
    const row = fixture.db.prepare<[], { encrypted_secrets: string; id: string }>("SELECT encrypted_secrets,id FROM integration_settings WHERE kind='telegram'").get()!;
    expect(row.encrypted_secrets).not.toContain(botToken); expect(fixture.secrets.decrypt(row.encrypted_secrets, `integration:${row.id}:telegram-token`)).toBe(botToken);
    peer.failure = true; const failure = await fixture.service.testTelegram();
    expect(failure.delivered).toBe(false); expect(JSON.stringify([failure, fixture.service.getTelegram()])).not.toContain(botToken); expect(JSON.stringify(failure)).not.toContain('api.telegram.org/bot');
  });
  it('includes provenance and stable event ID in bounded plain text, and deletion retains failed delivery audit', async () => {
    const peer = new TelegramProtocolPeer(); const fixture = await notificationFixture({ telegramApi: peer.api });
    await fixture.service.updateTelegram(telegramSetup);
    const event = fixture.enqueue([{ kind: 'telegram', chatId: '42' }]);
    fixture.db.prepare('UPDATE alert_events SET payload_json=? WHERE id=?').run(JSON.stringify({ ...event.payload, message: '<b>not markup</b>' + 'x'.repeat(6000) }), event.eventId);
    await fixture.service.idle();
    const text = String(peer.sends[0].text); expect(text.length).toBeLessThanOrEqual(4096); expect(text).toContain('COINBASE:BTC-USD'); expect(text).toContain(event.eventId); expect(text).toContain('2026-01-01T00:00:00.000Z'); expect(peer.sends[0]).not.toHaveProperty('parse_mode');
    fixture.service.setNotificationsPaused(true); const pending = fixture.enqueue([{ kind: 'telegram', chatId: '42' }]); fixture.service.deleteTelegram();
    expect(fixture.service.listDeliveries(pending.eventId)[0]).toMatchObject({ state: 'failed', lastError: 'Telegram destination was deleted.' }); expect(fixture.service.getTelegram().configured).toBe(false);
  });
});
