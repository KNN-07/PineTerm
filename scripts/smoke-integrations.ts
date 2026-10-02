import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { IntegrationTestResult, TelegramConfig, WebhookConfig } from '../packages/contracts/src/index.js';
import { runSandboxExecutorScenario } from './smoke/sandbox-executor.js';
import { runConfiguredAgentScenario } from './smoke/configured-agent.js';

const flags = new Set(process.argv.slice(2));
if ([...flags].some(flag => !['--telegram', '--webhook', '--executor', '--agent'].includes(flag))) throw new Error('Supported integration checks: --telegram, --webhook, --executor, --agent. Omit flags to request all four.');
const selected = flags.size ? [...flags] : ['--telegram', '--webhook', '--executor', '--agent'];
const base = new URL(process.env.PINETERM_SMOKE_URL ?? 'http://127.0.0.1:3000');
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('PINETERM_SMOKE_URL must be an HTTP(S) origin without credentials, query or path.');
const origin = process.env.PINETERM_SMOKE_ORIGIN ?? base.origin;
const password = process.env.PINETERM_SMOKE_ADMIN_PASSWORD ?? process.env.PINETERM_ADMIN_PASSWORD;
if (!password) throw new Error('Admin integration checks require PINETERM_SMOKE_ADMIN_PASSWORD in the environment; scoped API keys cannot configure or test channels.');
const login = await fetch(new URL('/api/v1/session', base), { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 200, 'Integration smoke administrator login failed. For dev use the Vite origin or set PINETERM_SMOKE_ORIGIN.');
const cookie = login.headers.get('set-cookie')?.split(';')[0];
const { csrfToken } = await login.json() as { csrfToken: string };
assert.ok(cookie && csrfToken, 'No authenticated session returned');

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(new URL('/api/v1' + path, base), {
    method, headers: { Cookie: cookie!, Origin: origin, 'x-csrf-token': csrfToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Integration API ${path.split('?')[0]} returned HTTP ${response.status}`);
  return await response.json() as T;
}

let failed = false;
try {
  for (const service of selected) {
    try {
      if (service === '--telegram') {
        const config = await api<TelegramConfig>('/integrations/telegram');
        if (!config.configured || !config.enabled || !config.allowedChatIds.length || !config.allowedUserIds.length) throw new Error('Configure a dedicated Telegram bot token, enable polling, and authorize both chat and user IDs through Settings.');
        const startedAt = Date.now();
        const result = await api<IntegrationTestResult>('/integrations/telegram/test', 'POST');
        assert.equal(result.delivered, true, result.message);
        console.log(`telegram: real getMe/sendMessage acknowledged · event ${result.eventId} · HTTP ${result.status} · ${new Date(result.observedAt).toISOString()}`);
        console.log('telegram: send /status from an authorized chat AND user now; waiting up to 120 seconds for a server-acknowledged command response.');
        let acknowledged: TelegramConfig['lastCommand'];
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          const current = await api<TelegramConfig>('/integrations/telegram');
          const command = current.lastCommand;
          if (command?.name === '/status' && command.observedAt >= startedAt && command.updateId >= config.updateOffset) { acknowledged = command; break; }
          if (current.status === 'webhook-conflict') throw new Error('This bot has an existing Telegram webhook; use a dedicated bot. PineTerm will not delete it.');
          await delay(1000);
        }
        assert.ok(acknowledged, 'Outgoing message acknowledged, but no fresh authorized /status reply acknowledgement was observed. Incoming live acceptance is blocked until the operator sends that command.');
        console.log(`telegram: authorized /status response sent · update ${acknowledged.updateId} · ${new Date(acknowledged.observedAt).toISOString()}`);
      } else if (service === '--executor') {
        await runSandboxExecutorScenario(base.origin, api);
      } else if (service === '--agent') {
        await runConfiguredAgentScenario(base.origin, api, { Cookie: cookie!, Origin: origin });
      } else {
        const { webhooks } = await api<{ webhooks: WebhookConfig[] }>('/webhooks');
        const id = process.env.PINETERM_SMOKE_WEBHOOK_ID ?? (webhooks.length === 1 ? webhooks[0]!.id : undefined);
        const webhook = webhooks.find(item => item.id === id);
        if (!webhook) throw new Error('Configure an operator-owned HTTPS receiver; set PINETERM_SMOKE_WEBHOOK_ID when more than one destination exists.');
        if (new URL(webhook.url).protocol !== 'https:') throw new Error('Real webhook acceptance requires HTTPS; a local HTTP recording receiver proves only the protocol.');
        const receiptValue = process.env.PINETERM_SMOKE_WEBHOOK_RECEIPT_URL;
        if (!receiptValue) throw new Error('Set PINETERM_SMOKE_WEBHOOK_RECEIPT_URL to an operator-owned HTTPS receipt endpoint that attests signature validation; a 2xx delivery alone is not HMAC proof.');
        const receiptUrl = new URL(receiptValue);
        if (receiptUrl.protocol !== 'https:' || receiptUrl.username || receiptUrl.password || receiptUrl.hash) throw new Error('Webhook receipt URL must use HTTPS without URL credentials or fragment.');
        const result = await api<IntegrationTestResult>(`/webhooks/${webhook.id}/test`, 'POST');
        assert.equal(result.delivered, true, result.message);
        receiptUrl.searchParams.set('eventId', result.eventId);
        const token = process.env.PINETERM_SMOKE_RECEIPT_TOKEN;
        const receiptResponse = await fetch(receiptUrl, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000), redirect: 'error' });
        assert.equal(receiptResponse.status, 200, 'Operator receipt endpoint did not acknowledge the event');
        const receipt = await receiptResponse.json() as { eventId?: string; signatureVerified?: boolean; receivedAt?: number };
        assert.equal(receipt.eventId, result.eventId, 'Receiver did not attest the delivered stable event ID');
        assert.equal(receipt.signatureVerified, true, 'Receiver did not attest HMAC validation over the received timestamp and raw bytes');
        assert.ok(Number.isSafeInteger(receipt.receivedAt) && Math.abs(receipt.receivedAt! - result.observedAt) <= 60000, 'Receiver receipt time is missing or outside the smoke observation window');
        console.log(`webhook: actual HTTPS delivery and operator signature receipt · event ${result.eventId} · HTTP ${result.status} · ${new Date(receipt.receivedAt!).toISOString()}`);
      }
    } catch (error) {
      failed = true;
      console.error(`${service.slice(2)}: BLOCKED — ${error instanceof Error ? error.message : 'Integration acceptance failed'}`);
    }
  }
} finally {
  const logout = await fetch(new URL('/api/v1/session', base), { method: 'DELETE', headers: { Cookie: cookie!, Origin: origin, 'x-csrf-token': csrfToken }, signal: AbortSignal.timeout(10000) });
  if (logout.status !== 204) { failed = true; console.error('session: integration smoke logout failed'); }
}
if (failed) process.exitCode = 1;
