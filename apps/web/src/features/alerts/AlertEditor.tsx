import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { TIMEFRAMES } from '@pineterm/contracts';
import type { AlertCommand, AlertDefinition, AlertDestination, AlertLeaf, MarketRef, PineInputMeta, PineValidation, PineValue, ScriptRecord, ScriptRevision, TelegramConfig, WebhookConfig } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import { Modal } from '../../Modal.js';
import './alerts.css';

export function commandFromAlert(alert: AlertDefinition): AlertCommand {
  return { name: alert.name, market: alert.market, timeframe: alert.timeframe, mode: alert.mode, frequency: alert.frequency, enabled: alert.enabled, condition: alert.condition, destinations: alert.destinations, ...(alert.scriptRevisionId ? { scriptRevisionId: alert.scriptRevisionId, inputs: alert.inputs ?? {} } : {}), ...(alert.warmupFrom !== null ? { warmupFrom: alert.warmupFrom } : {}) };
}
const PRICE_RULE: AlertLeaf = { kind: 'price', operator: 'crosses_above', price: '' };
const destinationKey = (value: AlertDestination) => value.kind === 'webhook' ? `webhook:${value.id}` : `telegram:${value.chatId}`;

function InputOverride({ meta, values, onChange }: { meta: PineInputMeta; values: Record<string, PineValue>; onChange: (values: Record<string, PineValue>) => void }) {
  const key = meta.varId ?? meta.id;
  const title = `${meta.title ?? meta.name} · ${key}`;
  const supported = ['string', 'number', 'boolean'].includes(typeof meta.defval);
  const overridden = Object.hasOwn(values, key);
  const value = overridden ? values[key]! : supported ? meta.defval as PineValue : '';
  const numeric = typeof value === 'number';
  const update = (next: PineValue) => onChange({ ...values, [key]: next });
  return <div className="input-override">
    <label className="alert-checkbox"><input type="checkbox" checked={overridden} disabled={!supported || meta.active === false} onChange={(event) => { if (event.target.checked) update(meta.defval as PineValue); else { const next = { ...values }; delete next[key]; onChange(next); } }} />Override {title}</label>
    {!supported ? <small>Structured runtime default cannot be overridden by this control.</small> : meta.options?.length ? <select aria-label={title} value={JSON.stringify(value)} disabled={!overridden} onChange={(event) => update(JSON.parse(event.target.value) as PineValue)}>{meta.options.filter((option) => ['string', 'number', 'boolean'].includes(typeof option)).map((option, index) => <option key={index} value={JSON.stringify(option)}>{String(option)}</option>)}</select> : typeof value === 'boolean' ? <select aria-label={title} value={String(value)} disabled={!overridden} onChange={(event) => update(event.target.value === 'true')}><option value="true">True</option><option value="false">False</option></select> : <input aria-label={title} type={numeric ? 'number' : 'text'} value={String(value)} disabled={!overridden} min={meta.minval} max={meta.maxval} step={meta.step ?? (meta.type.endsWith('int') ? 1 : 'any')} onChange={(event) => { if (!numeric) update(event.target.value); else if (event.target.value !== '' && Number.isFinite(Number(event.target.value))) update(Number(event.target.value)); }} />}
    <small>Declaration default: {JSON.stringify(meta.defval)}{meta.tooltip ? ` · ${meta.tooltip}` : ''}</small>
  </div>;
}

export function AlertEditor({ client, initial, market, timeframe, webhooks, telegram, onClose, onSaved, onSessionError }: {
  client: ApiClient; initial: AlertDefinition | null; market: MarketRef | null; timeframe: string; webhooks: WebhookConfig[]; telegram: TelegramConfig;
  onClose: () => void; onSaved: (alert: AlertDefinition) => void; onSessionError: (error: ApiError) => void;
}) {
  const [draft, setDraft] = useState<AlertCommand>(() => initial ? commandFromAlert(initial) : { name: '', market: market ?? { provider: 'coinbase', symbol: 'BTC-USD' }, timeframe, mode: 'bar-close', frequency: 'once_per_bar', enabled: true, condition: PRICE_RULE, destinations: [] });
  const [leaves, setLeaves] = useState<AlertLeaf[]>(() => initial ? initial.condition.kind === 'group' ? initial.condition.conditions : [initial.condition] : [PRICE_RULE]);
  const [group, setGroup] = useState<'single' | 'all' | 'any'>(() => initial?.condition.kind === 'group' ? initial.condition.operator : 'single');
  const [warmup, setWarmup] = useState(initial?.warmupFrom === null || initial?.warmupFrom === undefined ? '' : String(initial.warmupFrom));
  const [scripts, setScripts] = useState<ScriptRecord[]>([]);
  const [revisions, setRevisions] = useState<ScriptRevision[]>([]);
  const [scriptId, setScriptId] = useState('');
  const [validation, setValidation] = useState<PineValidation | null>(null);
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const libraryOperation = useRef<AbortController | null>(null);
  const rootRevision = useRef(draft.scriptRevisionId);
  rootRevision.current = draft.scriptRevisionId;
  const hasPine = leaves.some((leaf) => leaf.kind === 'pine');
  const invalidMode = hasPine && draft.mode === 'quote';
  const selectedRevision = revisions.find((revision) => revision.id === draft.scriptRevisionId);
  const fail = (failure: unknown) => { if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure); else setError(errorMessage(failure)); };
  useEffect(() => () => { operation.current?.abort(); libraryOperation.current?.abort(); }, []);
  useEffect(() => {
    libraryOperation.current?.abort();
    if (!hasPine) { setLibraryBusy(false); return; }
    const controller = new AbortController();
    setLibraryBusy(true); setScriptError(null);
    void client.request<{ scripts: ScriptRecord[] }>('/scripts', { signal: controller.signal }).then(async ({ scripts: rows }) => {
      if (controller.signal.aborted) return;
      setScripts(rows);
      const all: ScriptRevision[] = [];
      const rootScript = rows.find((script) => script.id === scriptId || script.currentRevisionId === rootRevision.current);
      const candidates = rootRevision.current ? rootScript ? [rootScript] : rows : [];
      for (const script of candidates) {
        const history = await client.request<{ revisions: ScriptRevision[] }>(`/scripts/${encodeURIComponent(script.id)}/revisions`, { signal: controller.signal });
        all.push(...history.revisions);
        if (history.revisions.some((revision) => revision.id === rootRevision.current)) break;
      }
      if (controller.signal.aborted) return;
      setRevisions(all);
      const root = all.find((revision) => revision.id === rootRevision.current);
      if (root) setScriptId(root.scriptId);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
      else setScriptError(errorMessage(failure));
    }).finally(() => { if (!controller.signal.aborted) setLibraryBusy(false); });
    return () => controller.abort();
  }, [client, hasPine, libraryVersion, onSessionError]);
  useEffect(() => {
    setValidation(null); setMetadataBusy(false);
    if (!hasPine || !selectedRevision) return;
    const controller = new AbortController(); setMetadataBusy(true); setScriptError(null);
    void client.request<PineValidation>('/scripts/validate', { method: 'POST', csrf: true, signal: controller.signal, body: { source: selectedRevision.source, inputs: selectedRevision.inputs, props: selectedRevision.props } }).then((result) => { if (!controller.signal.aborted) setValidation(result); }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
      else setScriptError(errorMessage(failure));
    }).finally(() => { if (!controller.signal.aborted) setMetadataBusy(false); });
    return () => controller.abort();
  }, [client, hasPine, selectedRevision, onSessionError]);

  async function chooseScript(id: string) {
    const script = scripts.find((row) => row.id === id);
    if (!script) { setScriptId(''); return; }
    libraryOperation.current?.abort();
    const controller = new AbortController(); libraryOperation.current = controller;
    setLibraryBusy(true); setScriptError(null);
    try {
      const history = await client.request<{ revisions: ScriptRevision[] }>(`/scripts/${encodeURIComponent(id)}/revisions`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const revision = history.revisions.find((row) => row.id === script.currentRevisionId);
      if (!revision) throw new Error('The selected script head is missing from its immutable revision history. Refresh the library before re-arming.');
      setScriptId(id); setRevisions(history.revisions);
      setDraft((current) => ({ ...current, scriptRevisionId: revision.id, inputs: revision.inputs }));
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
      else setScriptError(errorMessage(failure));
    } finally { if (!controller.signal.aborted) setLibraryBusy(false); }
  }
  function chooseRevision(id: string) {
    const revision = revisions.find((row) => row.id === id);
    setDraft((current) => ({ ...current, scriptRevisionId: id, inputs: revision?.inputs ?? {} }));
  }
  function toggleDestination(value: AlertDestination, checked: boolean) {
    setDraft((current) => ({ ...current, destinations: checked ? [...current.destinations.filter((item) => destinationKey(item) !== destinationKey(value)), value] : current.destinations.filter((item) => destinationKey(item) !== destinationKey(value)) }));
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    setError(null);
    if (draft.market.provider === 'csv') { setError('Imported CSV data is historical. Select an explicit live venue before arming an alert.'); return; }
    if (invalidMode) { setError('Quote mode accepts price-only conditions. Select confirmed bar close for Pine or mixed groups.'); return; }
    if (!leaves.length || leaves.length > 20 || (group === 'single' && leaves.length !== 1)) { setError('Select one condition, or an all/any group of up to 20 leaves.'); return; }
    if (leaves.some((leaf) => leaf.kind === 'price' && (!/^(?:\d+)(?:\.\d+)?$/.test(leaf.price.trim()) || !/[1-9]/.test(leaf.price)))) { setError('Price thresholds must be positive decimal strings, without exponent notation.'); return; }
    if (leaves.some((leaf) => leaf.kind === 'pine' && leaf.eventType === 'alertcondition' && !leaf.title?.trim())) { setError('Each alertcondition rule requires its exact declared title.'); return; }
    if (hasPine && !draft.scriptRevisionId) { setError('Select one immutable script revision shared by all Pine conditions.'); return; }
    if (warmup !== '' && (!/^\d+$/.test(warmup) || !Number.isSafeInteger(Number(warmup)))) { setError('Warm-up start must be a UTC epoch-millisecond integer.'); return; }
    const normalized = leaves.map((leaf): AlertLeaf => leaf.kind === 'price' ? { ...leaf, price: leaf.price.trim() } : leaf.eventType === 'alertcondition' ? { ...leaf, title: leaf.title!.trim() } : { kind: 'pine', eventType: 'alert' });
    const body: AlertCommand = { name: draft.name.trim(), market: { ...draft.market, symbol: draft.market.symbol.trim() }, timeframe: draft.timeframe, mode: draft.mode, frequency: draft.frequency, enabled: draft.enabled, condition: group === 'single' ? normalized[0]! : { kind: 'group', operator: group, conditions: normalized }, destinations: draft.destinations, ...(hasPine ? { scriptRevisionId: draft.scriptRevisionId!, inputs: draft.inputs ?? {} } : {}), ...(warmup !== '' ? { warmupFrom: Number(warmup) } : {}) };
    const controller = new AbortController(); operation.current = controller; setBusy(true);
    try {
      const { alert } = await client.request<{ alert: AlertDefinition }>(initial ? `/alerts/${encodeURIComponent(initial.id)}` : '/alerts', { method: initial ? 'PUT' : 'POST', csrf: true, signal: controller.signal, body: initial ? { ...body, revision: initial.revision } : body });
      if (!controller.signal.aborted) onSaved(alert);
    } catch (failure) { if (!controller.signal.aborted) fail(failure); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  const availableDestinations: AlertDestination[] = [...webhooks.map((webhook): AlertDestination => ({ kind: 'webhook', id: webhook.id })), ...telegram.allowedChatIds.map((chatId): AlertDestination => ({ kind: 'telegram', chatId }))];
  const unavailableDestinations = draft.destinations.filter((value) => !availableDestinations.some((item) => destinationKey(item) === destinationKey(value)));
  return <Modal title={initial ? 'Edit / re-arm alert' : 'Create server alert'} titleId="alert-editor-title" onClose={onClose} closeDisabled={busy}>
    <div className="alert-editor">
      <p>Uses authoritative live venue data, never chart previews or replay bars. First observation arms the baseline without firing. Saving explicitly re-arms; script library edits never update this selection automatically.</p>
      {error && <p className="message error" role="alert">{error}{initial && <small>A revision conflict requires closing this draft and refreshing the server definition; it is never overwritten.</small>}</p>}
      <form onSubmit={(event) => void save(event)}><fieldset disabled={busy}>
        <div className="alert-form-grid">
          <div className="form-field full-width"><label htmlFor="alert-name">Alert name</label><input id="alert-name" value={draft.name} required maxLength={100} onChange={(event) => setDraft({ ...draft, name: event.target.value })} autoFocus /></div>
          <div className="form-field"><label htmlFor="alert-provider">Live provider</label><select id="alert-provider" value={draft.market.provider} onChange={(event) => setDraft({ ...draft, market: { ...draft.market, provider: event.target.value as MarketRef['provider'] } })}><option value="coinbase">Coinbase · USD markets</option><option value="binance">Binance · USDT markets</option>{draft.market.provider === 'csv' && <option value="csv">CSV · historical, cannot arm</option>}</select></div>
          <div className="form-field"><label htmlFor="alert-symbol">Explicit venue symbol</label><input id="alert-symbol" value={draft.market.symbol} required maxLength={100} onChange={(event) => setDraft({ ...draft, market: { ...draft.market, symbol: event.target.value } })} /><small>No venue or currency substitution is performed.</small></div>
          <div className="form-field"><label htmlFor="alert-timeframe">Timeframe</label><select id="alert-timeframe" value={draft.timeframe} onChange={(event) => setDraft({ ...draft, timeframe: event.target.value })}>{TIMEFRAMES.map((value) => <option key={value} value={value}>{value === 'D' ? '1 day' : value === 'W' ? '1 week' : value === 'M' ? '1 month' : `${value} minutes`}</option>)}</select></div>
          <div className="form-field"><label htmlFor="alert-mode">Evaluation mode</label><select id="alert-mode" value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as AlertCommand['mode'] })}><option value="bar-close">Confirmed bar close</option><option value="quote">Live quote · price only</option></select></div>
          <div className="form-field"><label htmlFor="alert-frequency">Frequency</label><select id="alert-frequency" value={draft.frequency} onChange={(event) => setDraft({ ...draft, frequency: event.target.value as AlertCommand['frequency'] })}><option value="once_per_bar">Once per timeframe bar</option><option value="once">Once · then pause</option></select></div>
          <div className="form-field"><label htmlFor="alert-group">Condition combination</label><select id="alert-group" value={group} onChange={(event) => { const value = event.target.value as typeof group; setGroup(value); if (value === 'single') setLeaves((current) => current.slice(0, 1)); }}><option value="single">Single condition</option><option value="all">All conditions · same observation</option><option value="any">Any condition · same observation</option></select></div>
        </div>
        {invalidMode && <p className="message error" role="alert">Pine / mixed groups require confirmed bar-close mode. Quote mode is price only.</p>}
        <p className="muted">Bar-close groups evaluate leaves on the same confirmed bar. Quote above/below fires on false → true only; crossings compare previous/current price. No expiry unless paused or deleted.</p>
        {leaves.map((leaf, index) => <fieldset className="alert-leaf" key={index}><legend>Condition {index + 1}</legend><div className="form-field"><label htmlFor={`alert-kind-${index}`}>Condition type</label><select id={`alert-kind-${index}`} value={leaf.kind} onChange={(event) => setLeaves((current) => current.map((item, offset) => offset === index ? event.target.value === 'price' ? { ...PRICE_RULE } : { kind: 'pine', eventType: 'alert' } : item))}><option value="price">Price</option><option value="pine">Pine event · shared root revision</option></select></div>
          {leaf.kind === 'price' ? <div className="alert-form-grid"><div className="form-field"><label htmlFor={`alert-operator-${index}`}>Price operator</label><select id={`alert-operator-${index}`} value={leaf.operator} onChange={(event) => setLeaves((current) => current.map((item, offset) => offset === index ? { ...leaf, operator: event.target.value as typeof leaf.operator } : item))}><option value="above">Above</option><option value="below">Below</option><option value="crosses_above">Crosses above</option><option value="crosses_below">Crosses below</option></select></div><div className="form-field"><label htmlFor={`alert-price-${index}`}>Price · decimal string</label><input id={`alert-price-${index}`} value={leaf.price} required inputMode="decimal" pattern="[0-9]+(\.[0-9]+)?" onChange={(event) => setLeaves((current) => current.map((item, offset) => offset === index ? { ...leaf, price: event.target.value } : item))} /></div></div> : <><div className="form-field"><label htmlFor={`alert-event-${index}`}>Pine event type</label><select id={`alert-event-${index}`} value={leaf.eventType} onChange={(event) => setLeaves((current) => current.map((item, offset) => offset === index ? { kind: 'pine', eventType: event.target.value as 'alert' | 'alertcondition', ...(event.target.value === 'alertcondition' ? { title: leaf.title ?? '' } : {}) } : item))}><option value="alert">alert() calls</option><option value="alertcondition">Named alertcondition()</option></select></div>{leaf.eventType === 'alertcondition' && <div className="form-field"><label htmlFor={`alert-title-${index}`}>Exact alertcondition title</label><input id={`alert-title-${index}`} value={leaf.title ?? ''} required maxLength={200} onChange={(event) => setLeaves((current) => current.map((item, offset) => offset === index ? { ...leaf, title: event.target.value } : item))} /></div>}</>}
          {group !== 'single' && <button type="button" disabled={leaves.length <= 1} onClick={() => setLeaves((current) => current.filter((_, offset) => offset !== index))}>Remove condition {index + 1}</button>}
        </fieldset>)}
        {group !== 'single' && <div className="actions"><button type="button" disabled={leaves.length >= 20} onClick={() => setLeaves((current) => [...current, { ...PRICE_RULE }])}>Add condition · {leaves.length}/20</button></div>}
        {hasPine && <section><h3>Immutable Pine root · shared by every Pine leaf</h3><p>No source is submitted from the chart or replay. Explicit input overrides use variable/declaration IDs, not potentially duplicate display titles.</p>
          {scriptError && <p className="message error" role="alert">{scriptError}</p>}
          <div className="form-field"><label htmlFor="alert-script">Script library</label><select id="alert-script" value={scriptId} disabled={libraryBusy} onChange={(event) => void chooseScript(event.target.value)}><option value="">Select a saved script</option>{scripts.map((script) => <option value={script.id} key={script.id}>{script.name}</option>)}</select></div>
          <div className="form-field"><label htmlFor="alert-script-revision">Pinned script revision</label><select id="alert-script-revision" value={draft.scriptRevisionId ?? ''} disabled={libraryBusy} onChange={(event) => chooseRevision(event.target.value)}><option value="">Select an immutable revision</option>{draft.scriptRevisionId && !selectedRevision && <option value={draft.scriptRevisionId}>Preserved existing root · {draft.scriptRevisionId}</option>}{revisions.filter((row) => row.scriptId === scriptId).map((row) => <option value={row.id} key={row.id}>r{row.revision} · {new Date(row.createdAt).toISOString()}</option>)}</select><small>Root ID: {draft.scriptRevisionId ?? 'Not selected'}{selectedRevision ? ` · source hash ${selectedRevision.sourceHash}` : ''}</small></div>
          <button type="button" disabled={libraryBusy || metadataBusy} onClick={() => setLibraryVersion((value) => value + 1)}>Refresh library · keep pinned root</button>
          {libraryBusy || metadataBusy ? <p role="status">Loading immutable revisions / isolated input metadata…</p> : selectedRevision && validation?.valid ? <div className="input-overrides">{validation.inputs.length ? validation.inputs.map((meta) => <InputOverride key={meta.varId ?? meta.id} meta={meta} values={draft.inputs ?? {}} onChange={(inputs) => setDraft((current) => ({ ...current, inputs }))} />) : <p>No declared inputs.</p>}</div> : <p className="muted">{validation && !validation.valid ? validation.diagnostics.map((item) => `${item.code}: ${item.message}`).join('\n') : 'Select a readable revision to discover inputs. An archived/unavailable root and its existing overrides remain pinned until you explicitly replace it.'}</p>}
          {Object.keys(draft.inputs ?? {}).length > 0 && <details><summary>Submitted varID input overrides</summary><pre>{JSON.stringify(draft.inputs, null, 2)}</pre></details>}
        </section>}
        <section><h3>Fixed warm-up baseline</h3><div className="form-field"><label htmlFor="alert-warmup">Optional start · UTC epoch milliseconds</label><input id="alert-warmup" value={warmup} inputMode="numeric" pattern="[0-9]+" onChange={(event) => setWarmup(event.target.value)} /><small>Blank on first arm selects the last 500 confirmed bars and stores that start. It never rolls forward silently. An explicit earlier start may hit history/compute limits; the server pauses with an actionable reason. Preserve the stored value when re-arming unless you intentionally change it.</small></div></section>
        <section><h3>Notification destinations</h3><p className="muted">No destination means history only. Tests send labelled notifications to these explicit destinations and never simulate a condition.</p>
          {webhooks.map((webhook) => { const destination: AlertDestination = { kind: 'webhook', id: webhook.id }; return <label className="alert-checkbox" key={destinationKey(destination)}><input type="checkbox" checked={draft.destinations.some((item) => destinationKey(item) === destinationKey(destination))} onChange={(event) => toggleDestination(destination, event.target.checked)} />Webhook · {webhook.name}</label>; })}
          {telegram.allowedChatIds.map((chatId) => { const destination: AlertDestination = { kind: 'telegram', chatId }; return <label className="alert-checkbox" key={destinationKey(destination)}><input type="checkbox" checked={draft.destinations.some((item) => destinationKey(item) === destinationKey(destination))} onChange={(event) => toggleDestination(destination, event.target.checked)} />Telegram · chat {chatId}{!telegram.configured || !telegram.enabled ? ' · not currently enabled/configured' : ''}</label>; })}
          {unavailableDestinations.map((destination) => <label className="alert-checkbox" key={destinationKey(destination)}><input type="checkbox" checked onChange={() => toggleDestination(destination, false)} />Unavailable destination · {destinationKey(destination)} · uncheck to remove</label>)}
          {!webhooks.length && !telegram.allowedChatIds.length && <p>No configured destinations. Open Settings → Notifications to configure a webhook or Telegram bot.</p>}
        </section>
        <label className="alert-checkbox"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />Arm live evaluation after save</label>
        <div className="actions"><button type="submit" className="primary" disabled={invalidMode || draft.market.provider === 'csv' || (hasPine && !draft.scriptRevisionId) || metadataBusy}>{busy ? 'Saving…' : initial ? 'Save & explicitly re-arm' : 'Create alert'}</button><button type="button" onClick={onClose}>Cancel</button></div>
      </fieldset></form>
    </div>
  </Modal>;
}
