import { randomUUID } from 'node:crypto';
import type { AlertDelivery, AlertDestination, AlertPayload, CreateWebhook, IntegrationTestResult, NotificationStatus, TelegramConfig, UpdateTelegram, UpdateWebhook, WebhookConfig } from '@pineterm/contracts';
import type { AppDatabase } from '../database.js';
import type { Config } from '../config.js';
import type { InvalidationHub } from '../events.js';
import type { SecretStore } from '../secrets.js';
import { ApiError } from '../errors.js';
import { deliverWebhook, parseWebhookUrl, resolveWebhook, type DeliveryResult, type WebhookResolver } from './webhook.js';
import { parseTelegramResponse, parseTelegramUpdates, telegramAlertText, telegramDeliveryResult, telegramRequest, type TelegramApi, type TelegramMethod, type TelegramResponse, type TelegramUpdate } from './telegram.js';

export type { TelegramApi, TelegramResponse } from './telegram.js';
export interface NotificationOptions { telegramApi?: TelegramApi; resolveWebhook?: WebhookResolver }
export interface NotificationReadContext { status(): string; alerts(): string | Promise<string>; positions(): Promise<string> }
interface WebhookRow { id: string; name: string; url: string; encrypted_secret: string; revision: number; created_at: number; updated_at: number }
interface SettingRow { id: string; revision: number; public_config_json: string; encrypted_secrets: string | null; created_at: number; updated_at: number }
interface DeliveryRow { id: string; event_id: string; destination_kind: 'webhook' | 'telegram'; destination_id: string; state: AlertDelivery['state']; attempt_count: number; next_attempt_at: number; last_status: number | null; last_error: string | null; delivered_at: number | null; created_at: number }
interface TelegramPublic { allowedChatIds: string[]; allowedUserIds: string[]; enabled: boolean; status: TelegramConfig['status']; reason: string | null; botUsername: string | null; lastCommand?: TelegramConfig['lastCommand'] }
const RETRIES = [5000, 30000, 120000];
const NOT_CONFIGURED: TelegramPublic = { allowedChatIds: [], allowedUserIds: [], enabled: false, status: 'unconfigured', reason: 'Configure a dedicated bot token, allowed chats and allowed users.', botUsername: null };

/** Durable at-least-once transport. A timeout can mean the receiver accepted a message; event IDs never change on retry. */
export class NotificationService {
  private started = false;
  private closed = false;
  private context?: NotificationReadContext;
  private worker?: Promise<void>;
  private wakeRequested = false;
  private scheduler?: NodeJS.Timeout;
  private maintenance = 0;
  private activeDelivery?: { row: DeliveryRow; controller: AbortController };
  private readonly controllers = new Set<AbortController>();
  private readonly requests = new Set<Promise<unknown>>();
  private readonly managedDestinations = new Map<AbortController, string>();
  private pollController?: AbortController;
  private pollTask?: Promise<void>;
  private telegramGeneration = 0;

  constructor(private readonly db: AppDatabase, private readonly secrets: SecretStore, private readonly config: Config, private readonly clock: () => number, private readonly events: InvalidationHub, private readonly options: NotificationOptions = {}) {}

  async initialise(context: NotificationReadContext): Promise<void> {
    this.context = context; this.started = true;
    this.db.prepare("UPDATE alert_deliveries SET state='pending',next_attempt_at=?,last_error='Interrupted sending; delivery may be duplicated.' WHERE state='sending'").run(this.clock());
    await this.restartTelegram();
    this.wake();
  }
  async close(): Promise<void> {
    this.closed = true; this.started = false;
    clearTimeout(this.scheduler);
    this.pollController?.abort();
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...(this.worker ? [this.worker] : []), ...(this.pollTask ? [this.pollTask] : []), ...this.requests]);
  }
  private webhookRow(id: string): WebhookRow {
    const row = this.db.prepare<[string], WebhookRow>('SELECT * FROM webhooks WHERE id=?').get(id);
    if (!row) throw new ApiError(404, 'WEBHOOK_NOT_FOUND', 'The webhook does not exist.');
    return row;
  }
  listWebhooks(): WebhookConfig[] {
    return this.db.prepare<[], WebhookRow>('SELECT * FROM webhooks ORDER BY created_at,id').all().map(row => ({ id: row.id, name: row.name, url: row.url, revision: row.revision, secretConfigured: true, createdAt: row.created_at, updatedAt: row.updated_at }));
  }
  getWebhook(id: string): WebhookConfig {
    const row = this.webhookRow(id);
    return { id: row.id, name: row.name, url: row.url, revision: row.revision, secretConfigured: true, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  private async validateWebhook(body: CreateWebhook | UpdateWebhook): Promise<string> {
    if (!body.name.trim() || body.name.trim().length > 100) throw new ApiError(400, 'INVALID_NAME', 'Webhook name must contain 1–100 characters.');
    if (body.secret !== undefined && (Buffer.byteLength(body.secret) < 16 || Buffer.byteLength(body.secret) > 4096)) throw new ApiError(400, 'INVALID_WEBHOOK_SECRET', 'Webhook secret must contain 16–4096 UTF-8 bytes.');
    const url = parseWebhookUrl(body.url, this.config);
    await this.managed(signal => resolveWebhook(url, this.config, signal, this.options.resolveWebhook));
    return url.href;
  }
  async createWebhook(body: CreateWebhook): Promise<WebhookConfig> {
    const url = await this.validateWebhook(body); const id = randomUUID(); const now = this.clock();
    if (body.secret === undefined) throw new ApiError(400, 'WEBHOOK_SECRET_REQUIRED', 'Configure a webhook signing secret.');
    this.db.prepare('INSERT INTO webhooks(id,name,url,encrypted_secret,revision,created_at,updated_at) VALUES (?,?,?,?,1,?,?)').run(id, body.name.trim(), url, this.secrets.encrypt(body.secret, `webhook:${id}:secret`), now, now);
    return this.getWebhook(id);
  }
  async updateWebhook(id: string, body: UpdateWebhook): Promise<WebhookConfig> {
    this.webhookRow(id); const url = await this.validateWebhook(body);
    this.maintenance++;
    if (this.activeDelivery?.row.destination_kind === 'webhook' && this.activeDelivery.row.destination_id === id) this.activeDelivery.controller.abort();
    for (const [controller, destination] of this.managedDestinations) if (destination === `webhook:${id}`) controller.abort();
    try {
      await Promise.allSettled([this.worker, ...this.requests]);
      return this.db.transaction(() => {
        const current = this.webhookRow(id);
        if (current.revision !== body.revision) throw new ApiError(409, 'REVISION_CONFLICT', 'Webhook configuration changed; reload before saving.');
        const secret = body.secret === undefined ? current.encrypted_secret : this.secrets.encrypt(body.secret, `webhook:${id}:secret`);
        this.db.prepare('UPDATE webhooks SET name=?,url=?,encrypted_secret=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(body.name.trim(), url, secret, this.clock(), id, body.revision);
        return this.getWebhook(id);
      }).immediate();
    } finally { this.maintenance--; this.wake(); }
  }
  deleteWebhook(id: string): void {
    this.webhookRow(id);
    for (const [controller, destination] of this.managedDestinations) if (destination === `webhook:${id}`) controller.abort();
    this.db.transaction(() => {
      this.db.prepare("UPDATE alert_deliveries SET state='failed',last_error='Webhook destination was deleted.' WHERE destination_kind='webhook' AND destination_id=? AND state IN ('pending','sending')").run(id);
      this.db.prepare('DELETE FROM webhooks WHERE id=?').run(id);
    }).immediate();
    this.wake();
  }
  async testWebhook(id: string): Promise<IntegrationTestResult> {
    if (this.maintenance) throw new ApiError(409, 'CONFIGURATION_CHANGING', 'Notification configuration is changing; retry the test after saving completes.');
    const row = this.webhookRow(id); const eventId = randomUUID(); const occurredAt = this.clock();
    const payload: AlertPayload = { eventId, alertId: row.id, occurredAt, market: { provider: 'coinbase', symbol: 'TEST' }, timeframe: '1', message: '[PineTerm TEST] Explicit webhook connection test; not a trading signal.' };
    const result = await this.managed(signal => deliverWebhook(row.url, this.secrets.decrypt(row.encrypted_secret, `webhook:${id}:secret`), Buffer.from(JSON.stringify(payload)), String(occurredAt), this.config, signal, this.options.resolveWebhook), `webhook:${id}`);
    return { delivered: result.delivered, status: result.status, message: result.delivered ? 'Configured receiver returned a successful HTTP response. Receiver-side signature validation is not attested by this test.' : result.error!, eventId, observedAt: this.clock() };
  }
  private telegramRow(): SettingRow | undefined {
    return this.db.prepare<[], SettingRow>("SELECT * FROM integration_settings WHERE kind='telegram'").get();
  }
  getTelegram(): TelegramConfig {
    const row = this.telegramRow();
    if (!row) return { configured: false, revision: 0, ...NOT_CONFIGURED, updateOffset: 0 };
    const value = JSON.parse(row.public_config_json) as TelegramPublic;
    const offset = this.db.prepare<[string], { update_offset: number }>('SELECT update_offset FROM telegram_state WHERE integration_id=?').get(row.id)?.update_offset ?? 0;
    return { configured: row.encrypted_secrets !== null, revision: row.revision, allowedChatIds: value.allowedChatIds, allowedUserIds: value.allowedUserIds, enabled: value.enabled, status: value.status, reason: value.reason, botUsername: value.botUsername, updateOffset: offset, ...(value.lastCommand ? { lastCommand: value.lastCommand } : {}) };
  }
  async updateTelegram(body: UpdateTelegram): Promise<TelegramConfig> {
    if (!Number.isInteger(body.revision) || body.revision < 0 || !body.allowedChatIds.length || !body.allowedUserIds.length || body.allowedChatIds.length > 100 || body.allowedUserIds.length > 100 || body.allowedChatIds.some(id => !/^-?[1-9]\d{0,19}$/.test(id)) || body.allowedUserIds.some(id => !/^[1-9]\d{0,19}$/.test(id)) || new Set(body.allowedChatIds).size !== body.allowedChatIds.length || new Set(body.allowedUserIds).size !== body.allowedUserIds.length) {
      throw new ApiError(400, 'INVALID_TELEGRAM_ALLOWLIST', 'Provide distinct numeric chat IDs and positive user IDs (1–100 each).');
    }
    if (body.token !== undefined && !/^\d{1,20}:[A-Za-z0-9_-]{20,200}$/.test(body.token)) throw new ApiError(400, 'INVALID_TELEGRAM_TOKEN', 'Provide the bot token issued by Telegram BotFather.');
    const current = this.telegramRow();
    if ((!current && body.revision !== 0) || (current && current.revision !== body.revision)) throw new ApiError(409, 'REVISION_CONFLICT', 'Telegram configuration changed; reload before saving.');
    if (!current?.encrypted_secrets && !body.token) throw new ApiError(400, 'TELEGRAM_TOKEN_REQUIRED', 'A bot token is required for initial setup.');
    this.maintenance++;
    this.telegramGeneration++; this.pollController?.abort();
    if (this.activeDelivery?.row.destination_kind === 'telegram') this.activeDelivery.controller.abort();
    for (const [controller, destination] of this.managedDestinations) if (destination === 'telegram') controller.abort();
    try {
      await Promise.allSettled([this.worker, this.pollTask, ...this.requests]);
      this.db.transaction(() => {
        const latest = this.telegramRow();
        if ((latest?.revision ?? 0) !== body.revision) throw new ApiError(409, 'REVISION_CONFLICT', 'Telegram configuration changed; reload before saving.');
        const id = latest?.id ?? randomUUID(); const now = this.clock();
        const publicConfig: TelegramPublic = { allowedChatIds: body.allowedChatIds, allowedUserIds: body.allowedUserIds, enabled: body.enabled, status: 'checking', reason: null, botUsername: null };
        const encrypted = body.token === undefined ? latest!.encrypted_secrets : this.secrets.encrypt(body.token, `integration:${id}:telegram-token`);
        if (latest) this.db.prepare('UPDATE integration_settings SET revision=revision+1,public_config_json=?,encrypted_secrets=?,updated_at=? WHERE id=?').run(JSON.stringify(publicConfig), encrypted, now, id);
        else this.db.prepare("INSERT INTO integration_settings(id,kind,revision,public_config_json,encrypted_secrets,created_at,updated_at) VALUES (?,'telegram',1,?,?,?,?)").run(id, JSON.stringify(publicConfig), encrypted, now, now);
        this.db.prepare('INSERT INTO telegram_state(integration_id,update_offset,updated_at) VALUES (?,0,?) ON CONFLICT(integration_id) DO UPDATE SET update_offset=CASE WHEN ? THEN 0 ELSE telegram_state.update_offset END,updated_at=excluded.updated_at').run(id, now, body.token !== undefined ? 1 : 0);
        this.db.prepare("UPDATE alert_deliveries SET state='failed',last_error='Telegram chat is no longer allowed.' WHERE destination_kind='telegram' AND state IN ('pending','sending') AND destination_id NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify(body.allowedChatIds));
      }).immediate();
      await this.restartTelegram();
      return this.getTelegram();
    } finally { this.maintenance--; this.wake(); }
  }
  deleteTelegram(): void {
    this.telegramGeneration++; this.pollController?.abort();
    for (const [controller, destination] of this.managedDestinations) if (destination === 'telegram') controller.abort();
    this.db.transaction(() => {
      this.db.prepare("UPDATE alert_deliveries SET state='failed',last_error='Telegram destination was deleted.' WHERE destination_kind='telegram' AND state IN ('pending','sending')").run();
      this.db.prepare("DELETE FROM integration_settings WHERE kind='telegram'").run();
    }).immediate();
    this.wake();
  }
  getStatus(): NotificationStatus {
    const policy = this.db.prepare<[], { public_config_json: string }>("SELECT public_config_json FROM integration_settings WHERE kind='notification-policy'").get();
    const value: unknown = policy ? JSON.parse(policy.public_config_json) : undefined;
    const paused = Boolean(value && typeof value === 'object' && 'paused' in value && value.paused === true);
    return { paused, telegram: this.getTelegram() };
  }
  setNotificationsPaused(paused: boolean): NotificationStatus {
    const current = this.db.prepare<[], SettingRow>("SELECT * FROM integration_settings WHERE kind='notification-policy'").get();
    const now = this.clock();
    this.db.prepare("INSERT INTO integration_settings(id,kind,revision,public_config_json,encrypted_secrets,created_at,updated_at) VALUES (?,'notification-policy',1,?,NULL,?,?) ON CONFLICT(kind) DO UPDATE SET revision=integration_settings.revision+1,public_config_json=excluded.public_config_json,updated_at=excluded.updated_at").run(current?.id ?? randomUUID(), JSON.stringify({ paused }), now, now);
    if (paused) this.activeDelivery?.controller.abort();
    this.wake(); return this.getStatus();
  }
  validateDestinations(destinations: AlertDestination[]): void {
    const seen = new Set<string>(); const telegram = this.getTelegram();
    for (const destination of destinations) {
      const key = destination.kind + ':' + (destination.kind === 'webhook' ? destination.id : destination.chatId);
      if (seen.has(key)) throw new ApiError(400, 'DUPLICATE_DESTINATION', 'Each notification destination may be selected only once.');
      seen.add(key);
      if (destination.kind === 'webhook') this.webhookRow(destination.id);
      else if (!telegram.configured || !telegram.enabled || !telegram.allowedChatIds.includes(destination.chatId)) throw new ApiError(422, 'TELEGRAM_DESTINATION_UNAVAILABLE', 'Configure and enable Telegram with this allowed chat before arming an alert.');
    }
  }
  enqueue(eventId: string, destinations: AlertDestination[], now: number): void {
    this.validateDestinations(destinations);
    const insert = this.db.prepare("INSERT INTO alert_deliveries(id,event_id,destination_kind,destination_id,state,attempt_count,next_attempt_at,created_at) VALUES (?,?,?,?,'pending',0,?,?) ON CONFLICT(event_id,destination_kind,destination_id) DO NOTHING");
    for (const destination of destinations) insert.run(randomUUID(), eventId, destination.kind, destination.kind === 'webhook' ? destination.id : destination.chatId, now, now);
  }
  listDeliveries(eventId: string): AlertDelivery[] {
    return this.db.prepare<[string], DeliveryRow>('SELECT * FROM alert_deliveries WHERE event_id=? ORDER BY created_at,id').all(eventId).map(row => ({ id: row.id, eventId: row.event_id, destination: row.destination_kind === 'webhook' ? { kind: 'webhook', id: row.destination_id } : { kind: 'telegram', chatId: row.destination_id }, state: row.state, attempts: row.attempt_count, nextAttemptAt: row.next_attempt_at, lastStatus: row.last_status, lastError: row.last_error, deliveredAt: row.delivered_at, createdAt: row.created_at }));
  }
  wake(): void {
    if (this.activeDelivery) {
      const current = this.db.prepare<[string], { state: string }>('SELECT state FROM alert_deliveries WHERE id=?').get(this.activeDelivery.row.id);
      if (current?.state !== 'sending') this.activeDelivery.controller.abort();
    }
    if (!this.started || this.closed) return;
    this.wakeRequested = true;
    if (this.scheduler) { clearTimeout(this.scheduler); this.scheduler = undefined; }
    if (this.worker || this.maintenance) return;
    this.worker = Promise.resolve().then(async () => {
      do {
        this.wakeRequested = false;
        await this.drain();
      } while (this.wakeRequested && !this.closed && !this.maintenance);
    }).catch(() => {
      // No raw exception/logging: transport exceptions can contain a bot token or arbitrary receiver content.
      if (this.activeDelivery) this.db.prepare("UPDATE alert_deliveries SET state='pending',last_error='Notification worker interrupted.',next_attempt_at=? WHERE id=? AND state='sending'").run(this.clock() + 5000, this.activeDelivery.row.id);
    }).finally(() => { this.worker = undefined; if (this.wakeRequested && !this.closed && !this.maintenance) this.wake(); else this.schedule(); });
  }
  async idle(): Promise<void> {
    this.wake();
    while (this.worker) await this.worker;
  }
  private schedule(): void {
    if (this.closed || !this.started || this.maintenance || this.getStatus().paused) return;
    const next = this.db.prepare<[], { due: number | null }>("SELECT min(next_attempt_at) AS due FROM alert_deliveries WHERE state='pending'").get()?.due;
    if (next !== null && next !== undefined) {
      this.scheduler = setTimeout(() => { this.scheduler = undefined; this.wake(); }, Math.max(1, Math.min(2_147_000_000, next - this.clock())));
      this.scheduler.unref();
    }
  }
  private async drain(): Promise<void> {
    while (!this.closed && !this.maintenance && !this.getStatus().paused) {
      const row = this.db.transaction(() => {
        const candidate = this.db.prepare<[number], DeliveryRow>("SELECT * FROM alert_deliveries WHERE state='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at,id LIMIT 1").get(this.clock());
        if (!candidate) return undefined;
        const claimed = this.db.prepare("UPDATE alert_deliveries SET state='sending',attempt_count=attempt_count+1 WHERE id=? AND state='pending'").run(candidate.id);
        return claimed.changes ? { ...candidate, state: 'sending' as const, attempt_count: candidate.attempt_count + 1 } : undefined;
      }).immediate();
      if (!row) return;
      const controller = new AbortController(); this.controllers.add(controller); this.activeDelivery = { row, controller };
      let result: DeliveryResult;
      try { result = await this.send(row, controller.signal); }
      catch { result = { delivered: false, status: null, error: 'Notification transport failed or was interrupted.' }; }
      finally { this.controllers.delete(controller); this.activeDelivery = undefined; }
      const interrupted = controller.signal.aborted && !result.delivered;
      const retry = RETRIES[row.attempt_count - 1];
      const state: AlertDelivery['state'] = result.delivered ? 'delivered' : interrupted || (!result.terminal && retry !== undefined) ? 'pending' : 'failed';
      const now = this.clock();
      const invalidation = this.db.transaction(() => {
        const changed = this.db.prepare("UPDATE alert_deliveries SET state=?,attempt_count=?,next_attempt_at=?,last_status=?,last_error=?,delivered_at=? WHERE id=? AND state='sending' AND attempt_count=?").run(state, interrupted ? row.attempt_count - 1 : row.attempt_count, now + (state === 'pending' ? interrupted ? 0 : Math.max(retry ?? 0, result.retryAfterMs ?? 0) : 0), result.status, result.error, result.delivered ? now : null, row.id, row.attempt_count);
        if (!changed.changes) return undefined;
        const alert = this.db.prepare<[string], { alert_id: string; alert_revision: number }>('SELECT alert_id,alert_revision FROM alert_events WHERE id=?').get(row.event_id)!;
        return this.events.record('alerts.changed', alert.alert_id, alert.alert_revision);
      }).immediate();
      if (invalidation) this.events.emit(invalidation);
    }
  }
  private async send(row: DeliveryRow, signal: AbortSignal): Promise<DeliveryResult> {
    const current = this.db.prepare<[string], { state: string; archived_at: number | null }>('SELECT d.state,a.archived_at FROM alert_deliveries d JOIN alert_events e ON e.id=d.event_id JOIN alerts a ON a.id=e.alert_id WHERE d.id=?').get(row.id);
    if (current?.state !== 'sending' || signal.aborted) return { delivered: false, status: null, error: 'Delivery was interrupted.' };
    if (current.archived_at !== null) return { delivered: false, status: null, error: 'Alert was deleted.', terminal: true };
    const event = this.db.prepare<[string], { payload_json: string }>('SELECT payload_json FROM alert_events WHERE id=?').get(row.event_id);
    if (!event) return { delivered: false, status: null, error: 'Alert event is unavailable.', terminal: true };
    const stored = JSON.parse(event.payload_json) as AlertPayload & { kind?: string };
    const payload: AlertPayload = { eventId: row.event_id, alertId: stored.alertId, occurredAt: stored.occurredAt, market: stored.market, timeframe: stored.timeframe, message: stored.message, ...(stored.scriptRevisionId ? { scriptRevisionId: stored.scriptRevisionId } : {}) };
    if (row.destination_kind === 'webhook') {
      const target = this.db.prepare<[string], WebhookRow>('SELECT * FROM webhooks WHERE id=?').get(row.destination_id);
      if (!target) return { delivered: false, status: null, error: 'Webhook destination was deleted.', terminal: true };
      return deliverWebhook(target.url, this.secrets.decrypt(target.encrypted_secret, `webhook:${target.id}:secret`), Buffer.from(JSON.stringify(payload)), String(this.clock()), this.config, signal, this.options.resolveWebhook);
    }
    const telegram = this.getTelegram();
    if (!telegram.configured || !telegram.enabled || !telegram.allowedChatIds.includes(row.destination_id)) return { delivered: false, status: null, error: 'Telegram destination is disabled, deleted or no longer allowed.', terminal: true };
    if (telegram.status === 'webhook-conflict') return { delivered: false, status: null, error: telegram.reason, terminal: true };
    return telegramDeliveryResult(await this.callTelegram('sendMessage', { chat_id: row.destination_id, text: telegramAlertText(payload, stored.kind === 'test') }, signal));
  }
  private managed<T>(operation: (signal: AbortSignal) => Promise<T>, destination?: string): Promise<T> {
    if (this.closed) return Promise.reject(new ApiError(503, 'NOTIFICATIONS_CLOSED', 'Notification service is shutting down.'));
    const controller = new AbortController(); this.controllers.add(controller);
    if (destination) this.managedDestinations.set(controller, destination);
    const task = Promise.resolve().then(() => operation(controller.signal)).finally(() => { this.controllers.delete(controller); this.managedDestinations.delete(controller); this.requests.delete(task); });
    this.requests.add(task); return task;
  }
  private async callTelegram(method: TelegramMethod, body: Record<string, unknown>, signal: AbortSignal): Promise<TelegramResponse> {
    const row = this.telegramRow();
    if (!row?.encrypted_secrets) throw new ApiError(422, 'TELEGRAM_UNCONFIGURED', 'Telegram is not configured.');
    const token = this.secrets.decrypt(row.encrypted_secrets, `integration:${row.id}:telegram-token`);
    try {
      const response = await (this.options.telegramApi ? this.options.telegramApi(method, body, signal) : telegramRequest(token, method, body, signal));
      return parseTelegramResponse(response);
    }
    catch { throw new ApiError(503, 'TELEGRAM_UNAVAILABLE', 'Telegram connection failed, timed out or was interrupted.'); }
  }
  private setTelegramState(revision: number, status: TelegramConfig['status'], reason: string | null, botUsername?: string | null): void {
    const row = this.telegramRow(); if (!row || row.revision !== revision) return;
    const value = JSON.parse(row.public_config_json) as TelegramPublic;
    value.status = status; value.reason = reason;
    if (botUsername !== undefined) value.botUsername = botUsername;
    this.db.prepare('UPDATE integration_settings SET public_config_json=?,updated_at=? WHERE id=? AND revision=?').run(JSON.stringify(value), this.clock(), row.id, revision);
  }
  private async checkTelegram(signal: AbortSignal): Promise<boolean> {
    const config = this.getTelegram();
    if (!config.configured) return false;
    this.setTelegramState(config.revision, 'checking', null);
    try {
      const me = await this.callTelegram('getMe', {}, signal);
      if (!me.ok || !me.result || typeof me.result !== 'object' || !('id' in me.result) || typeof me.result.id !== 'number' || !Number.isSafeInteger(me.result.id)) throw new Error('Bot unavailable.');
      const username = 'username' in me.result && typeof me.result.username === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(me.result.username) ? me.result.username : null;
      const webhook = await this.callTelegram('getWebhookInfo', {}, signal);
      if (!webhook.ok || !webhook.result || typeof webhook.result !== 'object' || !('url' in webhook.result) || typeof webhook.result.url !== 'string') throw new Error('Webhook status unavailable.');
      if (webhook.result.url) {
        this.setTelegramState(config.revision, 'webhook-conflict', 'This bot already has a Telegram webhook. Use a dedicated bot, or remove that webhook in its owning application; PineTerm never deletes it.', username);
        return false;
      }
      this.setTelegramState(config.revision, 'connected', null, username); return true;
    } catch {
      if (!signal.aborted) this.setTelegramState(config.revision, 'unavailable', 'Telegram could not verify this bot and its webhook configuration.');
      return false;
    }
  }
  async testTelegram(): Promise<IntegrationTestResult> {
    if (this.maintenance) throw new ApiError(409, 'CONFIGURATION_CHANGING', 'Notification configuration is changing; retry the test after saving completes.');
    const config = this.getTelegram(); const eventId = randomUUID();
    if (!config.configured || !config.enabled || !config.allowedChatIds.length) return { delivered: false, status: null, message: 'Telegram is unconfigured or disabled; configure a dedicated bot and allowed chat.', eventId, observedAt: this.clock() };
    return this.managed(async signal => {
      if (!await this.checkTelegram(signal)) return { delivered: false, status: null, message: this.getTelegram().reason ?? 'Telegram is unavailable.', eventId, observedAt: this.clock() };
      try {
        const payload: AlertPayload = { eventId, alertId: eventId, occurredAt: this.clock(), market: { provider: 'coinbase', symbol: 'TEST' }, timeframe: '1', message: 'Explicit Telegram connection test; not a trading signal.' };
        const result = telegramDeliveryResult(await this.callTelegram('sendMessage', { chat_id: config.allowedChatIds[0], text: telegramAlertText(payload, true) }, signal));
        if (!result.delivered) this.setTelegramState(config.revision, 'unavailable', result.error);
        return { delivered: result.delivered, status: result.status, message: result.delivered ? 'Telegram accepted the labelled test message for the configured allowed chat.' : result.error!, eventId, observedAt: this.clock() };
      } catch { return { delivered: false, status: null, message: 'Telegram connection failed or timed out.', eventId, observedAt: this.clock() }; }
    }, 'telegram');
  }
  private async restartTelegram(): Promise<void> {
    const generation = ++this.telegramGeneration;
    this.pollController?.abort(); await this.pollTask;
    if (this.closed || !this.getTelegram().configured) return;
    const controller = new AbortController(); this.pollController = controller; this.controllers.add(controller);
    const connected = await this.checkTelegram(controller.signal);
    if (generation !== this.telegramGeneration || this.closed || !this.getTelegram().enabled) { controller.abort(); this.controllers.delete(controller); return; }
    this.pollTask = this.pollTelegram(controller, generation, connected).finally(() => { this.controllers.delete(controller); if (this.pollController === controller) this.pollController = undefined; });
  }
  private async pollTelegram(controller: AbortController, generation: number, connected: boolean): Promise<void> {
    while (!controller.signal.aborted && !this.closed && generation === this.telegramGeneration) {
      const config = this.getTelegram();
      if (!config.configured || !config.enabled || config.status === 'webhook-conflict') return;
      try {
        if (!connected) { await this.delay(5000, controller.signal); connected = await this.checkTelegram(controller.signal); if (!connected) continue; }
        const response = await this.callTelegram('getUpdates', { offset: config.updateOffset, timeout: 20, limit: 20, allowed_updates: ['message'] }, controller.signal);
        if (!response.ok || !Array.isArray(response.result)) {
          const result = telegramDeliveryResult(response);
          if (result.status === 409) { this.setTelegramState(config.revision, 'webhook-conflict', 'Telegram polling conflicts with a webhook or another poller. Use a dedicated bot; PineTerm never deletes webhooks.'); return; }
          this.setTelegramState(config.revision, 'unavailable', result.error);
          await this.delay(Math.max(5000, result.retryAfterMs ?? 0), controller.signal); connected = false; continue;
        }
        this.setTelegramState(config.revision, 'connected', null);
        const updates = parseTelegramUpdates(response.result).filter(update => update.update_id >= config.updateOffset).sort((left, right) => left.update_id - right.update_id);
        let nextOffset = config.updateOffset;
        for (const update of updates) {
          if (controller.signal.aborted || generation !== this.telegramGeneration) return;
          if (update.update_id < nextOffset) continue;
          nextOffset = update.update_id + 1;
          // Persist before command handling: a restarted poller cannot repeat a pause or portfolio response.
          const row = this.telegramRow(); if (!row || row.revision !== config.revision) return;
          this.db.prepare('UPDATE telegram_state SET update_offset=max(update_offset,?),updated_at=? WHERE integration_id=?').run(nextOffset, this.clock(), row.id);
          await this.handleTelegramUpdate(update, config, controller.signal);
        }
        // A fast empty response (including deterministic protocol peers) must not busy-loop.
        if (!updates.length) await this.delay(250, controller.signal);
      } catch {
        if (controller.signal.aborted) return;
        this.setTelegramState(config.revision, 'unavailable', 'Telegram polling failed or timed out.');
        connected = false;
      }
    }
  }
  private async handleTelegramUpdate(update: TelegramUpdate, config: TelegramConfig, signal: AbortSignal): Promise<void> {
    const message = update.message;
    if (!message || !Number.isSafeInteger(message.chat?.id) || !Number.isSafeInteger(message.from?.id) || message.from?.is_bot || !config.allowedChatIds.includes(String(message.chat!.id)) || !config.allowedUserIds.includes(String(message.from!.id))) return;
    const match = /^\/(status|alerts|positions|pause_alerts)(?:@([A-Za-z0-9_]+))?\s*$/.exec(message.text ?? '');
    if (!match || (match[2] && match[2].toLowerCase() !== config.botUsername?.toLowerCase()) || !this.context) return;
    let text: string;
    if (match[1] === 'status') text = this.context.status();
    else if (match[1] === 'alerts') text = await this.context.alerts();
    else if (match[1] === 'positions') text = await this.context.positions();
    else { this.setNotificationsPaused(true); text = 'PineTerm notifications paused. Alert evaluation and execution are unchanged. Re-enable notifications in administrator Settings.'; }
    if (signal.aborted) return;
    const response = await this.callTelegram('sendMessage', { chat_id: String(message.chat!.id), text: text.slice(0, 4096) }, signal);
    if (response.ok && !signal.aborted) {
      const row = this.telegramRow();
      if (!row || row.revision !== config.revision) return;
      const value = JSON.parse(row.public_config_json) as TelegramPublic;
      value.lastCommand = { name: `/${match[1]}` as NonNullable<TelegramConfig['lastCommand']>['name'], updateId: update.update_id, observedAt: this.clock() };
      this.db.prepare('UPDATE integration_settings SET public_config_json=?,updated_at=? WHERE id=? AND revision=?').run(JSON.stringify(value), this.clock(), row.id, config.revision);
    }
  }
  private async delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(finish, Math.min(milliseconds, 2_147_000_000));
    function finish() { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }
    signal.addEventListener('abort', finish, { once: true });
    return promise;
  }
}
