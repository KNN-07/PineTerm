import { useCallback, useEffect, useRef, useState } from 'react';
import type { AlertDefinition, AlertEvent, InvalidationEvent, MarketRef, NotificationStatus, TelegramConfig, WebhookConfig } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import { AlertEditor, commandFromAlert } from './AlertEditor.js';
import './alerts.css';

const time = (value: number | null) => value === null ? 'Not yet observed' : new Date(value).toISOString();
function conditionDescription(alert: AlertDefinition): string {
  const leaf = (condition: Exclude<AlertDefinition['condition'], { kind: 'group' }>) => condition.kind === 'price' ? `Price ${condition.operator.replaceAll('_', ' ')} ${condition.price}` : condition.eventType === 'alert' ? 'Pine alert()' : `Pine alertcondition(“${condition.title ?? ''}”)`;
  return alert.condition.kind === 'group' ? `${alert.condition.operator.toUpperCase()}: ${alert.condition.conditions.map(leaf).join('; ')}` : leaf(alert.condition);
}

export function AlertPanel({ client, market, timeframe, replayActive, onOpenNotifications, onOpenExecution, onOpenIntent, onSessionError }: {
  client: ApiClient; market: MarketRef | null; timeframe: string; replayActive: boolean; onOpenNotifications: () => void; onOpenExecution: () => void; onOpenIntent: (id: string) => void; onSessionError: (error: ApiError) => void;
}) {
  const [alerts, setAlerts] = useState<AlertDefinition[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);
  const [telegram, setTelegram] = useState<TelegramConfig | null>(null);
  const [notificationsPaused, setNotificationsPaused] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [editor, setEditor] = useState<{ initial: AlertDefinition | null } | null>(null);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const selected = alerts.find((alert) => alert.id === selectedId);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const fail = (failure: unknown) => { if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure); else setError(errorMessage(failure)); };
  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    void Promise.all([
      client.request<{ alerts: AlertDefinition[] }>('/alerts', { signal: controller.signal }),
      client.request<{ events: AlertEvent[] }>(`/alert-events${selectedId ? `?alertId=${encodeURIComponent(selectedId)}` : ''}`, { signal: controller.signal }),
      client.request<{ webhooks: WebhookConfig[] }>('/webhooks', { signal: controller.signal }),
      client.request<NotificationStatus>('/integrations/notifications', { signal: controller.signal }),
    ]).then(([definitions, history, destinations, status]) => {
      if (controller.signal.aborted) return;
      setAlerts(definitions.alerts); setEvents(history.events); setWebhooks(destinations.webhooks); setTelegram(status.telegram); setNotificationsPaused(status.paused);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
      else setError(errorMessage(failure));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, selectedId, version, onSessionError]);
  useEffect(() => {
    const source = new EventSource('/api/v1/events');
    source.onopen = refresh;
    source.addEventListener('invalidation', (event) => {
      try { const data = JSON.parse((event as MessageEvent<string>).data) as InvalidationEvent; if (data.type === 'alerts.changed' || data.type === 'live-intents.changed') refresh(); }
      catch { setError('The server event stream was unreadable. Refresh alert history to recover.'); }
    });
    return () => source.close();
  }, [refresh]);

  async function action(kind: 'pause' | 'resume' | 'delete' | 'test') {
    if (!selected || busy) return;
    if (kind === 'delete' && !window.confirm(`Delete “${selected.name}”? Evaluation stops; audit events and deliveries remain in history.`)) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(null); setNotice(null);
    try {
      const path = `/alerts/${encodeURIComponent(selected.id)}`;
      if (kind === 'delete') { await client.request<void>(path, { method: 'DELETE', csrf: true, signal: controller.signal }); if (!controller.signal.aborted) setSelectedId(''); }
      else if (kind === 'test') {
        const { event } = await client.request<{ event: AlertEvent }>(`${path}/test`, { method: 'POST', csrf: true, signal: controller.signal });
        if (!controller.signal.aborted) setNotice(`Labelled test event ${event.eventId} persisted. No live action is queued for a test. Delivery is at-least-once; inspect destination states below.`);
      } else {
        await client.request<{ alert: AlertDefinition }>(path, { method: 'PUT', csrf: true, signal: controller.signal, body: { ...commandFromAlert(selected), revision: selected.revision, enabled: kind === 'resume' } });
        if (!controller.signal.aborted) setNotice(kind === 'resume' ? 'Re-armed at the current live baseline. Missed history is not delivered as stale signals.' : 'Alert evaluation paused. Previously persisted delivery rows are retained.');
      }
      if (!controller.signal.aborted) { if (kind === 'delete') setNotice('Alert deleted. Retained audit events remain in All event history.'); refresh(); }
    } catch (failure) { if (!controller.signal.aborted) fail(failure); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <section className="alert-panel" aria-label="Durable server alerts" aria-busy={loading}>
    <div className="pane-title"><h2>Server alerts</h2><button type="button" className="primary" disabled={busy || !telegram} onClick={() => setEditor({ initial: null })}>New alert</button></div>
    <p className="readiness-note">Live alerts keep evaluating without an open browser{replayActive ? ', including during this replay' : ''}. They use independent live feeds, never replay bars or replay accounts.</p>
    <div className="actions"><button type="button" disabled={busy || loading} onClick={() => { setError(null); refresh(); }}>Refresh</button><button type="button" onClick={onOpenNotifications}>Notifications settings</button><button type="button" onClick={onOpenExecution}>Execution / kill switch</button></div>
    {notificationsPaused !== null && <p role="status">Notifications: <strong>{notificationsPaused ? 'globally paused' : 'active'}</strong>. This affects notification deliveries only. Fixed live execution actions continue when execution policy is enabled; pause their alert or use the execution kill switch.</p>}
    {error && <p className="message error" role="alert">{error}</p>}
    {notice && <p className="message" role="status">{notice}</p>}
    <div className="form-field"><label htmlFor="server-alert-select">Definition / event history</label><select id="server-alert-select" value={selectedId} disabled={busy} onChange={(event) => { setSelectedId(event.target.value); setNotice(null); }}><option value="">All event history · includes deleted alerts</option>{alerts.map((alert) => <option key={alert.id} value={alert.id}>{alert.name} · {alert.pausedReason ? 'needs attention' : alert.enabled ? 'armed' : 'paused'}</option>)}</select></div>
    {loading && <p role="status">Refreshing authoritative alert state…</p>}
    {!loading && !alerts.length && <p>No active definitions. Create an alert for the explicitly selected live venue; chart Pine previews do not arm server alerts.</p>}
    {selected && <section aria-label={`Alert ${selected.name}`}>
      <h3>{selected.name}</h3>
      <dl className="alert-details"><dt>Live market / interval</dt><dd>{selected.market.provider.toUpperCase()}:{selected.market.symbol} · {selected.timeframe}</dd><dt>Evaluation</dt><dd>{selected.mode === 'quote' ? 'Live quote · price only' : 'Confirmed bar close'} · {selected.frequency === 'once' ? 'Once' : 'Once per timeframe bar'} · r{selected.revision}</dd><dt>Conditions</dt><dd>{conditionDescription(selected)}</dd><dt>Evaluation status</dt><dd>{selected.enabled ? 'Armed' : 'Paused'}{selected.pausedReason ? ` · ${selected.pausedReason}` : ''}</dd><dt>Stored watermark</dt><dd>{time(selected.watermark)}</dd><dt>Fixed warm-up start</dt><dd>{time(selected.warmupFrom)}</dd><dt>Immutable script revision</dt><dd><code>{selected.scriptRevisionId ?? 'Price only'}</code>{selected.scriptRevisionId && <small>Library source changes do not update this ID. Select another revision in Edit / re-arm.</small>}</dd><dt>Destinations</dt><dd>{selected.destinations.length ? selected.destinations.map((destination) => destination.kind === 'webhook' ? `Webhook ${webhooks.find((row) => row.id === destination.id)?.name ?? destination.id}` : `Telegram chat ${destination.chatId}`).join(', ') : 'History only · no external delivery'}</dd></dl>
      {selected.liveAction && <section className="readiness-note"><h4>Fixed autonomous handoff action</h4><p>{selected.liveAction.market.provider.toUpperCase()}:{selected.liveAction.market.symbol} · {selected.liveAction.side} {selected.liveAction.quantity} · {selected.liveAction.type}{selected.liveAction.limitPrice ? ` @ limit ${selected.liveAction.limitPrice}` : ''}</p><small>Executor {selected.liveAction.executorId}. Fresh signals only; every action passes current execution policy checks. Notifications pause does not disable this action. Pine message text is never an order payload.</small></section>}
      {selected.inputs && Object.keys(selected.inputs).length > 0 && <details><summary>Pinned varID input overrides</summary><pre>{JSON.stringify(selected.inputs, null, 2)}</pre></details>}
      <div className="actions"><button type="button" disabled={busy || !telegram} onClick={() => setEditor({ initial: selected })}>Edit / re-arm</button><button type="button" disabled={busy} onClick={() => void action(selected.enabled ? 'pause' : 'resume')}>{selected.enabled ? 'Pause alert' : 'Resume / re-arm'}</button><button type="button" disabled={busy} onClick={() => void action('test')}>Send labelled test</button><button type="button" className="danger" disabled={busy} onClick={() => void action('delete')}>Delete alert</button></div>
    </section>}
    <section aria-label="Alert event and delivery history"><h3>Event & delivery history</h3><p className="muted">At-least-once notifications may duplicate after an ambiguous timeout. Receivers should deduplicate by stable event ID. Restart / outage intervals are history, not stale catch-up notifications.</p>
      {!events.length && !loading ? <p>No persisted events for this selection.</p> : <ol className="alert-history">{events.map((event) => <li key={event.eventId} className="alert-event"><h4>{event.kind === 'test' ? 'TEST · ' : event.kind === 'missed' ? 'MISSED INTERVAL · ' : 'SIGNAL · '}{event.market.provider.toUpperCase()}:{event.market.symbol} · {event.timeframe}</h4><p>{event.message}</p><small>Occurred {time(event.occurredAt)} · alert revision {event.alertRevision}</small><small>Event ID <code>{event.eventId}</code></small><small>Alert ID <code>{event.alertId}</code></small>{event.scriptRevisionId && <small>Immutable root <code>{event.scriptRevisionId}</code></small>}{event.missed && <small>Missed {time(event.missed.from)} → {time(event.missed.to)} · {event.missed.count} bars · {event.missed.reason}</small>}
        {event.kind === 'signal' && event.liveAction && <section className="readiness-note"><strong>Fixed live action · {event.liveAction.state}</strong>{event.liveAction.intentId && <><button type="button" onClick={() => onOpenIntent(event.liveAction!.intentId!)}>Open handoff intent</button><code>{event.liveAction.intentId}</code></>}{event.liveAction.error && <p className="message error">{event.liveAction.error.code}: {event.liveAction.error.message}</p>}{event.liveAction.state === 'pending' && <small>Pending current-policy checks. Only a fresh, unchanged live signal is eligible.</small>}{event.liveAction.state === 'failed' && <small>Terminal action failure: this signal will not be retried after policy changes.</small>}</section>}
        {event.kind !== 'signal' && <small>No live execution action is eligible for a {event.kind === 'test' ? 'labelled test' : 'missed interval'}.</small>}
        {event.deliveries.length ? <ul>{event.deliveries.map((delivery) => {
          const destination = delivery.destination;
          const label = destination.kind === 'webhook' ? `Webhook ${webhooks.find((row) => row.id === destination.id)?.name ?? destination.id}` : `Telegram ${destination.chatId}`;
          return <li key={delivery.id}><strong>{label} · {delivery.state}</strong><small>{delivery.attempts} attempt{delivery.attempts === 1 ? '' : 's'} · last HTTP status {delivery.lastStatus ?? 'none'}</small>{delivery.lastError && <p className="message error">{delivery.lastError}</p>}{delivery.state === 'pending' && <small>Next eligible attempt {time(delivery.nextAttemptAt)}</small>}{delivery.deliveredAt !== null && <small>Delivered {time(delivery.deliveredAt)}</small>}</li>;
        })}</ul> : <small>{event.kind === 'missed' ? 'No stale notification queued.' : 'No delivery destinations were queued.'}</small>}
      </li>)}</ol>}
    </section>
    {editor && telegram && <AlertEditor client={client} initial={editor.initial} market={market} timeframe={timeframe} webhooks={webhooks} telegram={telegram} onClose={() => setEditor(null)} onSessionError={onSessionError} onSaved={(alert) => { setEditor(null); setSelectedId(alert.id); setNotice(`“${alert.name}” saved at revision ${alert.revision}. ${alert.enabled ? 'Live evaluation armed.' : 'Evaluation paused.'}`); refresh(); }} />}
  </section>;
}
