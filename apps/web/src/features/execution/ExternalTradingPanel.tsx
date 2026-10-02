import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Instrument, LiveIntent, MarketRef, OrderIntentRequest, Quote } from '@pineterm/contracts';
import { ApiError, errorMessage } from '../../api.js';
import { ExecutionStatus, useExecution } from './ExecutionContext.js';
import { ExecutionRisk } from './ExecutionRisk.js';
import { emptyLiveAction, LiveActionFields, liveActionFromDraft } from './LiveActionFields.js';

interface PendingRequest { key: string; body: OrderIntentRequest }
const PENDING_KEY = 'pineterm.pendingLiveIntent';
function restoreRequest(): PendingRequest | null {
  const saved = sessionStorage.getItem(PENDING_KEY);
  if (!saved) return null;
  const row = JSON.parse(saved) as PendingRequest;
  if (!row || typeof row.key !== 'string' || !row.body || !Number.isSafeInteger(row.body.expiresAt)) throw new Error('Saved ambiguous handoff request is unreadable. Do not create another order; reconcile through the operator before clearing browser session data.');
  return row;
}
const terminal: Partial<Record<LiveIntent['state'], true>> = { filled: true, rejected: true, cancelled: true, expired: true };
export function ExternalTradingPanel({ liveMarket, replayLocked, onOpenExecution, selectedIntentId }: {
  liveMarket: MarketRef | null; replayLocked: boolean; onOpenExecution: () => void; selectedIntentId: string | null;
}) {
  const { client, policy, executors, intents, loading, error: loadError, refresh } = useExecution();
  const [draft, setDraft] = useState(emptyLiveAction);
  const [expirySeconds, setExpirySeconds] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [instrument, setInstrument] = useState<Instrument | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const operation = useRef(false);
  const replayRef = useRef(replayLocked); replayRef.current = replayLocked;
  const selectedRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    try { const saved = restoreRequest(); setPending(saved); if (saved) setNotice('Recovered an unresolved browser request. No order has been automatically sent. Retry only its identical request, or ask the operator to reconcile.'); }
    catch (failure) { setStorageError(errorMessage(failure)); }
  }, []);
  useEffect(() => { if (selectedIntentId) selectedRef.current?.scrollIntoView({ block: 'nearest' }); }, [selectedIntentId, intents]);
  useEffect(() => {
    const controller = new AbortController(); setInstrument(null); setQuote(null); setMarketError(null);
    if (draft.provider && draft.symbol.trim()) {
      const provider = draft.provider; const symbol = draft.symbol.trim();
      const timer = window.setTimeout(() => {
        void Promise.all([
          client.request<{ markets: Instrument[] }>(`/markets?${new URLSearchParams({ provider, q: symbol })}`, { signal: controller.signal }),
          client.request<Quote>(`/quotes?${new URLSearchParams({ provider, symbol })}`, { signal: controller.signal }),
        ]).then(([metadata, observed]) => { if (!controller.signal.aborted) { setInstrument(metadata.markets.find((row) => row.market.provider === provider && row.market.symbol === symbol) ?? null); setQuote(observed); } })
          .catch((failure: unknown) => { if (!controller.signal.aborted) setMarketError(errorMessage(failure)); });
      }, 350);
      return () => { window.clearTimeout(timer); controller.abort(); };
    }
    return () => controller.abort();
  }, [client, draft.provider, draft.symbol]);
  async function place(retry: boolean) {
    if (operation.current) return;
    if (replayRef.current) { setError('Replay is isolated. New handoffs and ambiguous request retries are locked; independently armed live alerts continue.'); return; }
    if (storageError) { setError(storageError); return; }
    let request: PendingRequest;
    try {
      if (retry && pending) request = pending;
      else {
        if (pending) throw new Error('Resolve the ambiguous request by exact retry before creating another handoff.');
        if (!policy?.enabled || loadError || loading) throw new Error('Refresh authoritative execution state and enable an explicit finite policy first.');
        const action = liveActionFromDraft(draft);
        const executor = executors.find((row) => row.id === action.executorId);
        if (!executor?.enabled || executor.archivedAt !== null || executor.claimsPausedReason) throw new Error('Choose an enabled executor without unresolved claim ambiguity.');
        if (!/^[1-9]\d*$/.test(expirySeconds) || Number(expirySeconds) > 60) throw new Error('Explicitly choose expiry from 1 to 60 seconds.');
        request = { key: crypto.randomUUID(), body: { ...action, expiresAt: Date.now() + Number(expirySeconds) * 1000 } };
        sessionStorage.setItem(PENDING_KEY, JSON.stringify(request)); setPending(request);
      }
    } catch (failure) { setError(errorMessage(failure)); return; }
    operation.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const { intent } = await client.request<{ intent: LiveIntent }>('/order-intents', { method: 'POST', csrf: true, body: request.body, headers: { 'Idempotency-Key': request.key } });
      sessionStorage.removeItem(PENDING_KEY); setPending(null); refresh();
      setNotice(`Intent ${intent.id} recorded as ${intent.state}. This is not an exchange acknowledgement or fill.`);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && failure.status !== 408) { sessionStorage.removeItem(PENDING_KEY); setPending(null); }
      else setNotice('Ambiguous response: the server may have accepted this intent. No automatic retry or new key. Use Retry identical request; unchanged expiry and idempotency key recover the original result.');
      setError(errorMessage(failure)); refresh();
    } finally { operation.current = false; setBusy(false); }
  }
  async function cancel(intent: LiveIntent) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const { intent: updated } = await client.request<{ intent: LiveIntent }>(`/order-intents/${encodeURIComponent(intent.id)}/cancel`, { method: 'POST', csrf: true });
      setNotice(updated.state === 'cancelled' ? 'Unclaimed intent cancelled by PineTerm; no venue cancellation is implied.' : 'Cancellation requested. External acceptance or unknown outcomes require an executor cancellation report. Venue cancellation is NOT guaranteed.'); refresh();
    } catch (failure) { setError(errorMessage(failure)); refresh(); }
    finally { operation.current = false; setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void place(false); }
  const enabledExecutor = executors.some((row) => row.enabled && row.archivedAt === null && !row.claimsPausedReason);
  return <section className="external-trading-panel" aria-label="External executor handoff">
    <div className="pane-title"><h2>External executor handoff · NOT paper trading</h2><button type="button" onClick={onOpenExecution}>Execution settings</button></div>
    <ExecutionStatus onOpenExecution={onOpenExecution} />
    <p>Queue a bounded intent for a registered operator driver. No exchange order is placed by the browser. All authoritative checks use fresh server data, never chart/replay prices. Claim or transport acknowledgement is not a fill.</p>
    {replayLocked && <p className="message error" role="status">Replay lock: the external ticket and exact retries cannot submit. Existing independent server live alerts, including explicitly fixed execution actions, continue on live feeds.</p>}
    {error && <p className="message error" role="alert">{error}</p>}{storageError && <p className="message error" role="alert">{storageError}</p>}{notice && <p className="message" role="status">{notice}</p>}
    <form onSubmit={submit}><fieldset disabled={replayLocked || busy || !!pending || !!storageError || loading || !!loadError || !policy?.enabled || !enabledExecutor}><legend>Explicit live intent · fresh expiry required</legend>
      <button type="button" disabled={!liveMarket || liveMarket.provider === 'csv'} onClick={() => { if (!replayRef.current && liveMarket && liveMarket.provider !== 'csv') setDraft((current) => ({ ...current, provider: liveMarket.provider as 'coinbase' | 'binance', symbol: liveMarket.symbol })); }}>Use active live chart market{liveMarket ? ` · ${liveMarket.provider.toUpperCase()}:${liveMarket.symbol}` : ''}</button>
      <LiveActionFields id="live-intent" draft={draft} onChange={setDraft} executors={executors} />
      <div className="form-field"><label htmlFor="live-intent-expiry">Expires after · explicitly choose 1–60 seconds</label><input id="live-intent-expiry" required inputMode="numeric" value={expirySeconds} onChange={(event) => setExpirySeconds(event.target.value)} /><small>The absolute expiry is fixed on the first attempt; an exact retry never extends it.</small></div>
      {instrument && <p>Venue metadata: {instrument.baseCurrency}/{instrument.quoteCurrency} · tick {instrument.tickSize} · quantity step {instrument.quantityStep}. No USD/USDT conversion.</p>}
      {quote && <p>Latest displayed observation: {quote.price} {instrument?.quoteCurrency ?? 'quote currency not verified'} · {quote.status} · {new Date(quote.observedAt).toISOString()}. The server rechecks at creation and claim.</p>}
      {marketError && <p className="message error">Live market observation unavailable: {marketError}</p>}
      <button type="submit" className="danger">Queue live handoff intent</button>
    </fieldset></form>
    {pending && <section className="readiness-note"><h3>Ambiguous request · exact retry only</h3><p>Idempotency key <code>{pending.key}</code> · original expiry {new Date(pending.body.expiresAt).toISOString()}. No automatic resubmission, altered body, or new key.</p><details><summary>Original request</summary><pre>{JSON.stringify(pending.body, null, 2)}</pre></details><button type="button" disabled={busy || replayLocked || !!storageError} onClick={() => void place(true)}>Retry identical request</button></section>}
    <section aria-label="Live handoff intent history"><div className="pane-title"><h3>Authoritative intent / report history</h3><button type="button" disabled={busy} onClick={refresh}>Refresh handoffs</button></div>
      {selectedIntentId && !intents.some((intent) => intent.id === selectedIntentId) && !loading && <p>Linked intent {selectedIntentId} is not in the current history. Refresh authoritative state or inspect execution audit.</p>}
      {!intents.length && !loading && <p>No live handoff intents. Paper orders are displayed separately above.</p>}
      <ol className="execution-cards">{intents.map((intent) => <li key={intent.id} ref={intent.id === selectedIntentId ? selectedRef : undefined} className={intent.id === selectedIntentId ? 'selected-intent' : ''}><h4>{intent.market.provider.toUpperCase()}:{intent.market.symbol} · {intent.side} {intent.quantity} · {intent.type}</h4><strong>{intent.state}{intent.cancelRequested ? ' · CANCEL REQUESTED, not venue-confirmed cancellation' : ''}</strong><code>Stable clientOrderId / intent ID: {intent.id}</code><dl className="execution-details"><dt>Executor</dt><dd>{executors.find((row) => row.id === intent.executorId)?.name ?? intent.executorId}</dd><dt>Reference / observed</dt><dd>{intent.referencePrice} {intent.quoteCurrency} · {new Date(intent.referenceObservedAt).toISOString()}</dd><dt>Protected execution price range</dt><dd>{intent.minExecutionPrice ?? 'none'} – {intent.maxExecutionPrice ?? 'none'} · deviation {intent.maximumDeviationBps} bps{intent.limitPrice ? ` · limit ${intent.limitPrice}` : ''}</dd><dt>Requested / retained risk</dt><dd>{intent.risk.requestedNotional} / {intent.risk.retainedNotional} {intent.quoteCurrency}</dd><dt>Reported filled quantity</dt><dd>{intent.filledQuantity} / {intent.quantity}</dd><dt>External order ID</dt><dd>{intent.externalOrderId ?? 'Not reported'}</dd><dt>Created / expiry</dt><dd>{new Date(intent.createdAt).toISOString()} / {new Date(intent.expiresAt).toISOString()}</dd>{intent.sourceEventId && <><dt>Fixed live alert source</dt><dd>{intent.sourceEventId}</dd></>}</dl>{intent.state === 'unknown' && <p className="message error">Unknown external outcome. Risk remains reserved and this executor cannot claim new orders. Only driver status reconciliation of this stable clientOrderId can resolve it; do not redispatch.</p>}{!terminal[intent.state] && <button type="button" className="danger" disabled={busy || intent.cancelRequested} onClick={() => void cancel(intent)}>{intent.cancelRequested ? 'Awaiting executor cancellation report' : intent.state === 'pending' ? 'Cancel unclaimed intent' : 'Request external cancellation'}</button>}<details><summary>Executor-reported outcomes · {intent.reports.length}</summary>{intent.reports.length ? <ul className="execution-cards">{intent.reports.map((report) => <li key={report.id}><strong>{report.status}</strong><small>Report {report.reportId} · {new Date(report.createdAt).toISOString()}</small>{report.fills.map((fill) => <p key={fill.externalFillId}>Fill {fill.externalFillId}: {fill.quantity} @ {fill.price} {intent.quoteCurrency} · fee / rebate {fill.fee} {fill.currency} · {new Date(fill.time).toISOString()}</p>)}</li>)}</ul> : <p>No external acknowledgement or fills reported.</p>}</details></li>)}</ol>
    </section>
    <ExecutionRisk />
  </section>;
}
