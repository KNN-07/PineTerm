import { request } from 'node:https';
import type { AlertPayload } from '@pineterm/contracts';
import type { DeliveryResult } from './webhook.js';

export type TelegramMethod = 'getMe' | 'getWebhookInfo' | 'sendMessage' | 'getUpdates';
export interface TelegramResponse { ok: boolean; result?: unknown; error_code?: number; parameters?: { retry_after?: number } }
export type TelegramApi = (method: TelegramMethod, body: Record<string, unknown>, signal: AbortSignal) => Promise<TelegramResponse>;
export interface TelegramUpdate { update_id: number; message?: { text?: string; chat?: { id?: number }; from?: { id?: number; is_bot?: boolean } } }

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function parseTelegramResponse(value: unknown): TelegramResponse {
  if (!object(value) || typeof value.ok !== 'boolean') throw new Error('Telegram returned an invalid response.');
  const response: TelegramResponse = { ok: value.ok, result: value.result };
  if (typeof value.error_code === 'number' && Number.isInteger(value.error_code)) response.error_code = value.error_code;
  if (object(value.parameters) && typeof value.parameters.retry_after === 'number' && Number.isFinite(value.parameters.retry_after) && value.parameters.retry_after >= 0) response.parameters = { retry_after: value.parameters.retry_after };
  return response;
}
export function parseTelegramUpdates(values: unknown[]): TelegramUpdate[] {
  const updates: TelegramUpdate[] = [];
  for (const value of values) {
    if (!object(value) || typeof value.update_id !== 'number' || !Number.isSafeInteger(value.update_id) || value.update_id < 0) continue;
    const update: TelegramUpdate = { update_id: value.update_id };
    if (object(value.message)) {
      update.message = {};
      if (typeof value.message.text === 'string') update.message.text = value.message.text;
      if (object(value.message.chat) && typeof value.message.chat.id === 'number' && Number.isSafeInteger(value.message.chat.id)) update.message.chat = { id: value.message.chat.id };
      if (object(value.message.from) && typeof value.message.from.id === 'number' && Number.isSafeInteger(value.message.from.id)) update.message.from = { id: value.message.from.id, is_bot: value.message.from.is_bot === true };
    }
    updates.push(update);
  }
  return updates;
}

/** Production transport has no configurable base URL, redirect handling or token-bearing error text. */
export async function telegramRequest(token: string, method: TelegramMethod, body: Record<string, unknown>, signal: AbortSignal): Promise<TelegramResponse> {
  const raw = Buffer.from(JSON.stringify(body));
  if (raw.length > 256 * 1024) throw new Error('Telegram request exceeds 256 KiB.');
  const { promise, resolve, reject } = Promise.withResolvers<TelegramResponse>();
  const req = request({ hostname: 'api.telegram.org', protocol: 'https:', path: `/bot${token}/${method}`, method: 'POST', agent: false, signal, headers: { 'content-type': 'application/json', 'content-length': raw.length } }, response => {
    const chunks: Buffer[] = []; let bytes = 0;
    response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) req.destroy(new Error('Telegram response limit exceeded.')); else chunks.push(chunk); });
    response.on('error', () => finish(new Error('Telegram response was interrupted.')));
    response.on('end', () => {
      try {
        if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) throw new Error('Telegram redirects are not permitted.');
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        finish(undefined, parseTelegramResponse(value));
      } catch { finish(new Error('Telegram returned an invalid or unsupported response.')); }
    });
  });
  const timer = setTimeout(() => req.destroy(new Error('Telegram request timed out.')), method === 'getUpdates' ? 30_000 : 10_000);
  function finish(error?: Error, value?: TelegramResponse) { clearTimeout(timer); if (error) reject(error); else resolve(value!); }
  req.on('error', () => finish(new Error(signal.aborted ? 'Telegram request was interrupted.' : 'Telegram connection failed or timed out.')));
  req.end(raw);
  return promise;
}
export function telegramDeliveryResult(response: TelegramResponse): DeliveryResult {
  if (response.ok) return { delivered: true, status: 200, error: null };
  const status = Number.isInteger(response.error_code) && response.error_code! >= 400 && response.error_code! <= 599 ? response.error_code! : 503;
  const retry = response.parameters?.retry_after;
  return { delivered: false, status, error: `Telegram returned error ${status}.`, terminal: status >= 400 && status < 500 && status !== 429, retryAfterMs: status === 429 && typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 ? Math.min(retry * 1000, 2_147_000_000) : undefined };
}
export function telegramAlertText(payload: AlertPayload, test = false): string {
  const prefix = `${test ? '[PineTerm TEST]' : '[PineTerm alert]'} ${payload.market.provider.toUpperCase()}:${payload.market.symbol} ${payload.timeframe}\n${new Date(payload.occurredAt).toISOString()}\nEvent ID: ${payload.eventId}\n`;
  // Keep provenance/ID even when Pine's untrusted message must be truncated. No parse_mode is ever set.
  return prefix + payload.message.slice(0, Math.max(0, 4096 - prefix.length));
}
