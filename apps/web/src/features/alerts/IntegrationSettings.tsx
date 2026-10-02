import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { CreateWebhook, IntegrationTestResult, NotificationStatus, TelegramConfig, UpdateTelegram, UpdateWebhook, WebhookConfig } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import { Modal } from '../../Modal.js';
import { SettingsNavigation } from './SettingsNavigation.js';
import './alerts.css';

export function IntegrationSettings({ client, onClose, onOpenData, onOpenSecurity, onSessionExpired }: {
  client: ApiClient; onClose: () => void; onOpenData: () => void; onOpenSecurity: () => void; onSessionExpired: () => void;
}) {
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);
  const [telegram, setTelegram] = useState<TelegramConfig | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  const [editingWebhook, setEditingWebhook] = useState<WebhookConfig | null>(null);
  const [webhookName, setWebhookName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [telegramToken, setTelegramToken] = useState('');
  const [chatIds, setChatIds] = useState('');
  const [userIds, setUserIds] = useState('');
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ label: string; result: IntegrationTestResult } | null>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    void Promise.all([
      client.request<{ webhooks: WebhookConfig[] }>('/webhooks', { signal: controller.signal }),
      client.request<TelegramConfig>('/integrations/telegram', { signal: controller.signal }),
      client.request<NotificationStatus>('/integrations/notifications', { signal: controller.signal }),
    ]).then(([destinations, bot, policy]) => {
      if (controller.signal.aborted) return;
      setWebhooks(destinations.webhooks); setTelegram(bot); setPaused(policy.paused);
      setChatIds(bot.allowedChatIds.join('\n')); setUserIds(bot.allowedUserIds.join('\n')); setTelegramEnabled(bot.enabled);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionExpired();
      else setError(errorMessage(failure));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, version, onSessionExpired]);

  async function mutate(action: string, task: (signal: AbortSignal) => Promise<void>) {
    if (busy) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(action); setError(null); setNotice(null); setTestResult(null);
    setWebhookSecret(''); setTelegramToken('');
    try { await task(controller.signal); if (!controller.signal.aborted) setVersion((current) => current + 1); }
    catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionExpired();
      else setError(errorMessage(failure));
    } finally { if (!controller.signal.aborted) setBusy(null); }
  }
  function saveWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const secretBytes = new TextEncoder().encode(webhookSecret).byteLength;
    if ((!editingWebhook || webhookSecret) && (secretBytes < 16 || secretBytes > 4096)) { setError('Webhook signing secrets must contain 16–4096 UTF-8 bytes.'); setWebhookSecret(''); setTelegramToken(''); return; }
    const body: CreateWebhook | UpdateWebhook = editingWebhook ? { revision: editingWebhook.revision, name: webhookName.trim(), url: webhookUrl.trim(), ...(webhookSecret ? { secret: webhookSecret } : {}) } : { name: webhookName.trim(), url: webhookUrl.trim(), secret: webhookSecret };
    void mutate('webhook-save', async (signal) => {
      const { webhook } = await client.request<{ webhook: WebhookConfig }>(editingWebhook ? `/webhooks/${encodeURIComponent(editingWebhook.id)}` : '/webhooks', { method: editingWebhook ? 'PUT' : 'POST', csrf: true, body, signal });
      if (signal.aborted) return;
      setEditingWebhook(null); setWebhookName(''); setWebhookUrl('');
      setNotice(`Webhook “${webhook.name}” saved at revision ${webhook.revision}. The secret is encrypted at rest and cannot be read back.`);
    });
  }
  function saveTelegram(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!telegram) return;
    const chats = [...new Set(chatIds.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean))];
    const users = [...new Set(userIds.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean))];
    if (chats.length < 1 || chats.length > 100 || users.length < 1 || users.length > 100 || chats.some((id) => !/^-?[1-9]\d{0,19}$/.test(id)) || users.some((id) => !/^[1-9]\d{0,19}$/.test(id))) { setError('Supply 1–100 distinct numeric chat IDs and 1–100 positive user IDs, each up to 20 digits. Use commas or new lines, not usernames; zero and leading zero IDs are invalid.'); setWebhookSecret(''); setTelegramToken(''); return; }
    if ((!telegram.configured || telegramToken.trim()) && !/^\d{1,20}:[A-Za-z0-9_-]{20,200}$/.test(telegramToken.trim())) { setError('Supply a valid dedicated Telegram bot token from BotFather before saving initial configuration.'); setWebhookSecret(''); setTelegramToken(''); return; }
    const body: UpdateTelegram = { revision: telegram.revision, allowedChatIds: chats, allowedUserIds: users, enabled: telegramEnabled, ...(telegramToken.trim() ? { token: telegramToken.trim() } : {}) };
    void mutate('telegram-save', async (signal) => {
      await client.request<TelegramConfig>('/integrations/telegram', { method: 'PUT', csrf: true, body, signal });
      if (!signal.aborted) setNotice('Telegram configuration saved. Refresh shows the server-observed bot status; saving is not proof of delivery.');
    });
  }

  return <Modal title="Settings · notifications" titleId="notification-settings-title" onClose={onClose} closeDisabled={busy !== null}>
    <div className="notification-settings">
      <SettingsNavigation active="notifications" onData={onOpenData} onSecurity={onOpenSecurity} onNotifications={() => {}} disabled={busy !== null} />
      <div className="pane-title"><h3>Durable delivery channels</h3><button type="button" disabled={busy !== null || loading} onClick={() => { setWebhookSecret(''); setTelegramToken(''); setEditingWebhook(null); setWebhookName(''); setWebhookUrl(''); setError(null); setVersion((value) => value + 1); }}>Refresh saved configuration</button></div>
      <p>Only this administrator session can configure channels. Tokens and signing secrets are write-only, encrypted by the server, and never stored in browser storage. Entered secrets are cleared when a request starts or this drawer closes.</p>
      {loading && <p role="status">Loading server configuration…</p>}
      {error && <p className="message error" role="alert">{error}<small>On a revision conflict, refresh the saved configuration before editing again. No force overwrite is performed.</small></p>}
      {notice && <p className="message" role="status">{notice}</p>}
      {testResult && <div className={`message notification-result ${testResult.result.delivered ? '' : 'error'}`} role="status"><strong>{testResult.label}: {testResult.result.delivered ? 'delivered' : 'not delivered'}</strong><p>{testResult.result.message}</p><small>HTTP status {testResult.result.status ?? 'none'} · observed {new Date(testResult.result.observedAt).toISOString()}</small><small>Stable test event ID <code>{testResult.result.eventId}</code></small></div>}
      <section className="notification-policy" aria-label="Global notification policy"><h3>Notifications only · global pause</h3><p>{paused === null ? 'Policy not loaded.' : paused ? 'Persisted notification deliveries are paused.' : 'Notification deliveries are active.'} Alert evaluation, paper trading, and execution policy are independent. This switch does not disable trading or stop armed conditions.</p><button type="button" disabled={paused === null || busy !== null || loading} onClick={() => void mutate('pause', async (signal) => { const status = await client.request<NotificationStatus>('/integrations/notifications', { method: 'PUT', csrf: true, signal, body: { paused: !paused } }); if (!signal.aborted) { setPaused(status.paused); setNotice(status.paused ? 'Notifications paused. Conditions continue to evaluate independently.' : 'Notifications resumed. Inspect durable delivery history for outstanding rows.'); } })}>{paused ? 'Resume notifications' : 'Pause notifications'}</button></section>
      <section aria-labelledby="webhook-settings-title"><h3 id="webhook-settings-title">Signed HTTPS webhooks</h3><p>Receivers verify <code>X-PineTerm-Signature: sha256=…</code> as HMAC-SHA256 of the timestamp, a period, and the exact raw body. Delivery is at-least-once; deduplicate by event ID.</p><p className="muted">HTTPS only. Private, loopback, link-local and metadata destinations, redirects and DNS rebinding are rejected. Only an explicitly configured development exact-host exception permits a local protocol receiver.</p>
        {webhooks.length === 0 && !loading ? <p>No webhook configured. Supply your receiver URL and its shared signing secret below.</p> : <ul className="notification-webhooks">{webhooks.map((webhook) => <li key={webhook.id} className="notification-webhook"><header><strong>{webhook.name}</strong><span>r{webhook.revision}</span></header><code>{webhook.url}</code><small>Secret {webhook.secretConfigured ? 'configured · write-only' : 'not configured'} · ID {webhook.id}</small><div className="actions"><button type="button" disabled={busy !== null} onClick={() => { setEditingWebhook(webhook); setWebhookName(webhook.name); setWebhookUrl(webhook.url); setWebhookSecret(''); setTelegramToken(''); setError(null); }}>Edit webhook</button><button type="button" disabled={busy !== null} onClick={() => void mutate(`webhook-test:${webhook.id}`, async (signal) => { const result = await client.request<IntegrationTestResult>(`/webhooks/${encodeURIComponent(webhook.id)}/test`, { method: 'POST', csrf: true, signal }); if (!signal.aborted) setTestResult({ label: webhook.name, result }); })}>Send webhook test</button><button type="button" className="danger" disabled={busy !== null} onClick={() => { if (window.confirm(`Delete webhook “${webhook.name}”? Existing alerts may still reference it; edit their destinations explicitly.`)) void mutate(`webhook-delete:${webhook.id}`, async (signal) => { await client.request<void>(`/webhooks/${encodeURIComponent(webhook.id)}`, { method: 'DELETE', csrf: true, signal }); if (!signal.aborted) { if (editingWebhook?.id === webhook.id) { setEditingWebhook(null); setWebhookName(''); setWebhookUrl(''); } setNotice('Webhook deleted. Retained delivery history is not erased.'); } }); }}>Delete</button></div></li>)}</ul>}
        <form onSubmit={saveWebhook}><fieldset disabled={busy !== null || loading}><legend>{editingWebhook ? `Edit webhook · revision ${editingWebhook.revision}` : 'Create webhook'}</legend><div className="alert-form-grid"><div className="form-field"><label htmlFor="webhook-name">Webhook name</label><input id="webhook-name" value={webhookName} onChange={(event) => setWebhookName(event.target.value)} required maxLength={100} /></div><div className="form-field"><label htmlFor="webhook-url">HTTPS destination URL</label><input id="webhook-url" type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} required maxLength={2048} autoComplete="off" spellCheck={false} /></div><div className="form-field full-width"><label htmlFor="webhook-secret">{editingWebhook ? 'Replacement signing secret · blank keeps current' : 'Shared signing secret · write-only'}</label><input id="webhook-secret" type="password" value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} required={!editingWebhook} maxLength={4096} autoComplete="off" spellCheck={false} /><small>16–4096 UTF-8 bytes. Not recoverable after save. Configure the same secret securely at your receiver.</small></div></div><div className="actions"><button type="submit" className="primary">{busy === 'webhook-save' ? 'Saving…' : editingWebhook ? 'Save webhook revision' : 'Create webhook'}</button>{editingWebhook && <button type="button" onClick={() => { setEditingWebhook(null); setWebhookName(''); setWebhookUrl(''); setWebhookSecret(''); }}>Cancel edit</button>}</div></fieldset></form>
      </section>
      <section aria-labelledby="telegram-settings-title"><h3 id="telegram-settings-title">Telegram · dedicated bot</h3><p>Use a dedicated bot created with <a href="https://core.telegram.org/bots/features#botfather" target="_blank" rel="noopener noreferrer">BotFather</a>. PineTerm long-polls <code>getUpdates</code>; it never automatically deletes an existing Telegram webhook. If the bot already has a webhook, remove it deliberately through Telegram or configure a different dedicated bot.</p>
        {telegram && <dl className="alert-details"><dt>Server-observed status</dt><dd>{telegram.status}{telegram.reason ? ` · ${telegram.reason}` : ''}</dd><dt>Bot</dt><dd>{telegram.botUsername ? `@${telegram.botUsername}` : 'Not identified'} · token {telegram.configured ? 'configured · write-only' : 'not configured'}</dd><dt>Configuration revision / update offset</dt><dd>r{telegram.revision} · {telegram.updateOffset}</dd></dl>}
        {telegram?.lastCommand && <p className="muted">Last authorized bot command: <code>{telegram.lastCommand.name}</code> · update {telegram.lastCommand.updateId} · {new Date(telegram.lastCommand.observedAt).toISOString()}</p>}
        {telegram?.status === 'unconfigured' && <p className="readiness-note">No bot token has been supplied. Add a real token and your explicit chat/user IDs below, then use Test. No connection or message acceptance has been fabricated.</p>}
        {telegram?.status === 'webhook-conflict' && <p className="message error" role="alert">This bot uses a Telegram webhook and cannot safely be long-polled. PineTerm will not remove it automatically. Follow the <a href="https://core.telegram.org/bots/api#deletewebhook" target="_blank" rel="noopener noreferrer">official deleteWebhook instructions</a> only if you own that bot and intend to stop its current receiver; otherwise use a dedicated bot.</p>}
        <form onSubmit={saveTelegram}><fieldset disabled={busy !== null || loading || !telegram}>
          <div className="form-field"><label htmlFor="telegram-token">{telegram?.configured ? 'Replacement bot token · blank keeps current' : 'Bot token · write-only'}</label><input id="telegram-token" type="password" value={telegramToken} onChange={(event) => setTelegramToken(event.target.value)} required={!telegram?.configured} maxLength={221} autoComplete="off" spellCheck={false} /><small>Never paste this token into chat, source control, a URL, or browser storage.</small></div>
          <div className="alert-form-grid"><div className="form-field"><label htmlFor="telegram-chat-ids">Allowed chat IDs · one per line or comma</label><textarea id="telegram-chat-ids" value={chatIds} onChange={(event) => setChatIds(event.target.value)} required rows={3} spellCheck={false} /><small>1–100 numeric IDs, not usernames. Negative group IDs are accepted. Start the bot in your chat before sending a test.</small></div><div className="form-field"><label htmlFor="telegram-user-ids">Allowed user IDs · one per line or comma</label><textarea id="telegram-user-ids" value={userIds} onChange={(event) => setUserIds(event.target.value)} required rows={3} spellCheck={false} /><small>1–100 positive user IDs. Incoming commands require both an allowed chat and an allowed sender user ID.</small></div></div>
          <label className="alert-checkbox"><input type="checkbox" checked={telegramEnabled} onChange={(event) => setTelegramEnabled(event.target.checked)} />Enable Telegram delivery and command polling</label>
          <p className="muted">Messages are plain text, capped at 4096 characters, with symbol / time / event ID; no HTML or Markdown parse mode. Allowed commands: <code>/status</code>, <code>/alerts</code>, <code>/positions</code> (read-only), and <code>/pause_alerts</code> (pauses notifications only). There are no buy/sell or model-generated actions.</p>
          <div className="actions"><button type="submit" className="primary">{busy === 'telegram-save' ? 'Saving…' : 'Save Telegram configuration'}</button><button type="button" disabled={!telegram?.configured} onClick={() => void mutate('telegram-test', async (signal) => { const result = await client.request<IntegrationTestResult>('/integrations/telegram/test', { method: 'POST', csrf: true, signal }); if (!signal.aborted) setTestResult({ label: 'Telegram getMe / test message', result }); })}>Test getMe / message</button><button type="button" className="danger" disabled={!telegram?.configured} onClick={() => { if (window.confirm('Delete the encrypted Telegram configuration and stop polling? Historical deliveries remain recorded.')) void mutate('telegram-delete', async (signal) => { await client.request<void>('/integrations/telegram', { method: 'DELETE', csrf: true, signal }); if (!signal.aborted) setNotice('Telegram configuration deleted. No remote webhook was changed.'); }); }}>Delete configuration</button></div>
        </fieldset></form>
      </section>
    </div>
  </Modal>;
}
