import { useCallback, useEffect, useRef, useState } from 'react';
import type { IndicatorHandle } from '@luxalgo/vela';
import type { VelaWorkspace, WorkspaceScriptRun } from '@luxalgo/vela/workspace';
import { PINE_TEMPLATES, createPineTemplate, pineSourceVersion, type AppliedAgentDraft, type Instrument, type InvalidationEvent, type PineValidation, type PineValue, type ScriptRecord, type ScriptRevision } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import type { ActiveChart } from '../workspace/ChartWorkspace.js';
import { PineEditor } from './PineEditor.js';
import { PineSettings } from './PineSettings.js';
import { StrategyTester } from './StrategyTester.js';
import type { AgentScriptSelection } from '../agent/AgentPanel.js';
import './scripts.css';

interface SavedScript { script: ScriptRecord; revision: ScriptRevision }
const EMPTY_SOURCE = '//@version=6\nindicator("Untitled", overlay=true)\nplot(close, "Close")\n';

export function ScriptsDock({ client, workspace, active, replayLocked, tab, onTab, onSessionError, onAgentContext, appliedAgentDraft }: { client: ApiClient; workspace: VelaWorkspace | null; active: ActiveChart; replayLocked: boolean; tab: 'editor' | 'tester' | 'trading'; onTab: (tab: 'editor' | 'tester') => void; onSessionError: (failure: ApiError) => void; onAgentContext: (value: AgentScriptSelection) => void; appliedAgentDraft: AppliedAgentDraft | null }) {
  const [scripts, setScripts] = useState<ScriptRecord[]>([]);
  const [saved, setSaved] = useState<SavedScript | null>(null);
  const [revision, setRevision] = useState<ScriptRevision | null>(null);
  const [revisions, setRevisions] = useState<ScriptRevision[]>([]);
  const [name, setName] = useState('Untitled'); const [source, setSource] = useState(EMPTY_SOURCE);
  const [inputs, setInputs] = useState<Record<string, PineValue>>({}); const [props, setProps] = useState<Record<string, PineValue>>({});
  const [validation, setValidation] = useState<PineValidation | null>(null);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [conflict, setConflict] = useState(false);
  const [documentKey, setDocumentKey] = useState('new'); const [templateId, setTemplateId] = useState('sma');
  const [placement, setPlacement] = useState<'declaration' | 'overlay' | 'pane'>('declaration');
  const [handles, setHandles] = useState<IndicatorHandle[]>([]);
  const [preview, setPreview] = useState<WorkspaceScriptRun | null>(null);
  const [instrument, setInstrument] = useState<Instrument | null>(null);
  const [libraryVersion, setLibraryVersion] = useState(0); const [jobVersion, setJobVersion] = useState(0);
  const booted = useRef(false); const operation = useRef<AbortController | null>(null);
  const dirty = !revision || source !== revision.source || name !== saved?.script.name || JSON.stringify(inputs) !== JSON.stringify(revision.inputs) || JSON.stringify(props) !== JSON.stringify(revision.props);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const openedAgentRevision = useRef<string | null>(null);
  useEffect(() => {
    const diagnostic = validation?.diagnostics[0];
    onAgentContext({ revisionId: revision?.id ?? null, name: saved?.script.name ?? null, sourceSaved: !!revision && !dirty, diagnostic: diagnostic ? `${diagnostic.code}: ${diagnostic.message}${diagnostic.line === undefined ? '' : ` · line ${diagnostic.line}`}` : error?.startsWith('Browser Pine preview:') ? error : null });
  }, [revision?.id, saved?.script.name, dirty, validation, error, onAgentContext]);
  const fail = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
    setError(errorMessage(failure));
  }, [onSessionError]);
  const restore = useCallback((value: SavedScript, selected = value.revision) => {
    setSaved(value); setRevision(selected); setName(value.script.name); setSource(selected.source); setInputs(selected.inputs); setProps(selected.props);
    booted.current = true;
    setValidation(null); setConflict(false); setError(null); setDocumentKey(selected.id); setPlacement('declaration');
  }, []);

  useEffect(() => {
    if (!appliedAgentDraft || openedAgentRevision.current === appliedAgentDraft.revision.id) return;
    openedAgentRevision.current = appliedAgentDraft.revision.id;
    setLibraryVersion(current => current + 1);
    if (dirtyRef.current && booted.current && !window.confirm('The Pi draft was applied as a saved script. Discard your current unsaved editor draft and open its new revision? Cancel keeps your editor draft; the applied script remains in the library.')) {
      setNotice(`Applied “${appliedAgentDraft.script.name}” is saved in the library. Current unsaved editor draft preserved; select the applied script when ready.`);
      return;
    }
    restore({ script: appliedAgentDraft.script, revision: appliedAgentDraft.revision });
    setRevisions([appliedAgentDraft.revision]);
    setNotice('User-applied Pi revision opened. It has not been run on the chart or used to arm an alert. Use Backtest to select an explicit UTC range.');
    const controller = new AbortController();
    void client.request<{ revisions: ScriptRevision[] }>(`/scripts/${encodeURIComponent(appliedAgentDraft.script.id)}/revisions`, { signal: controller.signal }).then(({ revisions: values }) => { if (!controller.signal.aborted) setRevisions(values); }).catch(failure => { if (!controller.signal.aborted) fail(failure); });
    return () => controller.abort();
  }, [appliedAgentDraft, client, restore, fail]);

  useEffect(() => {
    const controller = new AbortController();
    void client.request<{ scripts: ScriptRecord[] }>('/scripts', { signal: controller.signal }).then(async ({ scripts: rows }) => {
      if (controller.signal.aborted) return;
      setScripts(rows);
      if (!booted.current && rows.length) {
        const first = rows.find((row) => row.name === 'PineTerm SMA') ?? rows[0]!;
        const value = await client.request<SavedScript>(`/scripts/${first.id}`, { signal: controller.signal });
        const history = await client.request<{ revisions: ScriptRevision[] }>(`/scripts/${first.id}/revisions`, { signal: controller.signal });
        if (!controller.signal.aborted && !booted.current) { restore(value); setRevisions(history.revisions); }
      }
    }).catch((failure: unknown) => { if (!controller.signal.aborted) fail(failure); });
    return () => controller.abort();
  }, [client, libraryVersion, restore, fail]);
  useEffect(() => {
    const events = new EventSource('/api/v1/events');
    events.onopen = () => { setLibraryVersion((value) => value + 1); setJobVersion((value) => value + 1); };
    events.addEventListener('invalidation', (event) => {
      const value = JSON.parse((event as MessageEvent<string>).data) as InvalidationEvent;
      if (value.type === 'scripts.changed') setLibraryVersion((current) => current + 1);
      if (value.type === 'jobs.changed') setJobVersion((current) => current + 1);
    });
    return () => events.close();
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setInstrument(null);
    if (active.market) {
      const market = active.market;
      const params = new URLSearchParams({ provider: market.provider, q: market.symbol });
      void client.request<{ markets: Instrument[] }>(`/markets?${params}`, { signal: controller.signal }).then(({ markets }) => { if (!controller.signal.aborted) setInstrument(markets.find((item) => item.market.provider === market.provider && item.market.symbol === market.symbol) ?? null); }).catch((failure: unknown) => { if (!controller.signal.aborted) fail(failure); });
    }
    return () => controller.abort();
  }, [client, active.market?.provider, active.market?.symbol, fail]);
  useEffect(() => {
    if (!workspace) { setHandles([]); setPreview(null); return; }
    const chart = workspace.cell(active.cellId)?.chart;
    if (!chart) return;
    const refresh = () => setHandles([...chart.indicators()]);
    setPreview(null); refresh();
    const stops = [chart.on('indicator:added', refresh), chart.on('indicator:removed', refresh), chart.on('indicator:error', ({ error: failure }) => { setError(`Browser Pine preview: ${failure.message}`); refresh(); }), workspace.on('script:run', (run) => { if (run.cell === active.cellId) { setPreview(run); refresh(); } })];
    return () => { for (const stop of stops) stop(); };
  }, [workspace, active.cellId, active.market?.provider, active.market?.symbol, active.timeframe]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirtyRef.current && booted.current) event.preventDefault(); };
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('beforeunload', unload); operation.current?.abort(); };
  }, []);

  async function selectScript(id: string, discard = false) {
    if (busy || (!discard && dirty && !window.confirm('Discard this unsaved Pine draft and open another script?'))) return;
    setBusy(true); setError(null);
    try { const value = await client.request<SavedScript>(`/scripts/${id}`); const history = await client.request<{ revisions: ScriptRevision[] }>(`/scripts/${id}/revisions`); restore(value); setRevisions(history.revisions); setNotice('Saved revision restored. Compilation is not implied by saving.'); }
    catch (failure) { fail(failure); } finally { setBusy(false); }
  }
  async function save(copy = false): Promise<SavedScript | null> {
    setError(null);
    try {
      const body = { name: copy ? `${name} copy`.slice(0, 100) : name, source, inputs, props };
      const value = await client.request<SavedScript>(!saved || copy ? '/scripts' : `/scripts/${saved.script.id}`, { method: !saved || copy ? 'POST' : 'PUT', csrf: true, body: !saved || copy ? body : { ...body, revision: saved.script.revision } });
      restore(value); setRevisions((rows) => copy ? [value.revision] : [value.revision, ...rows]); setLibraryVersion((current) => current + 1);
      setNotice(`Saved immutable revision ${value.revision.revision}. Use Validate or Add to chart to check compilation.`); return value;
    } catch (failure) { if (failure instanceof ApiError && failure.status === 409) setConflict(true); fail(failure); return null; }
  }
  async function action(kind: 'save' | 'copy' | 'validate' | 'chart' | 'backtest' | 'archive') {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (kind === 'save' || kind === 'copy') { await save(kind === 'copy'); return; }
      if (kind === 'archive') {
        if (!saved || !window.confirm(`Archive “${saved.script.name}”? Existing immutable revisions and jobs remain available.`)) return;
        await client.request<void>(`/scripts/${saved.script.id}`, { method: 'DELETE', csrf: true });
        setSaved(null); setRevision(null); setRevisions([]); setLibraryVersion((current) => current + 1); setNotice('Archived. This source remains an unsaved draft; Save creates a new library entry.'); return;
      }
      if (kind === 'backtest') {
        if (dirty || !revision) { const value = await save(); if (!value) return; }
        onTab('tester'); setNotice('Choose an explicit UTC date range in Strategy Tester, then Run backtest.'); return;
      }
      const controller = new AbortController(); operation.current = controller;
      const validated = await client.request<PineValidation>('/scripts/validate', { method: 'POST', csrf: true, body: { source, inputs, props }, signal: controller.signal });
      setValidation(validated);
      if (!validated.valid) { setNotice('Compilation failed. No new indicator was added.'); return; }
      if (kind === 'validate') { setNotice(`Pine ${validated.declarationType} compiled in the isolated runner; ${validated.inputs.length} inputs discovered.`); return; }
      const chart = workspace?.cell(active.cellId)?.chart;
      if (!chart) throw new Error('The active chart is not ready.');
      if (workspace!.active.id !== active.cellId || chart.market.symbol !== `${active.market?.provider.toUpperCase()}:${active.market?.symbol}` || (chart.market.timeframe ?? '60') !== active.timeframe) throw new Error('The chart selection changed during validation. Select the intended chart and Add again.');
      const declaredOverlay = props.overlay ?? validated.props.find(meta => meta.name === 'overlay')?.defval;
      const overlay = placement === 'declaration' ? declaredOverlay : placement === 'overlay';
      const result = await chart.runIndicator(source, { id: `pineterm:${crypto.randomUUID()}`, title: name, inputs, props, ...(typeof overlay === 'boolean' ? { overlay, pane: overlay ? 'price' : 'new' } : {}) });
      if (!result.ok) throw result.error ?? new Error('Pine preview failed without a diagnostic.');
      setHandles([...chart.indicators()]); setNotice('Added browser preview to the active chart. Use isolated backtests for persisted simulation/provenance.');
      workspace?.root.dispatchEvent(new Event('pineterm:pine-state'));
    } catch (failure) { fail(failure); } finally { operation.current = null; setBusy(false); }
  }
  function newScript(template = false) {
    if (dirty && booted.current && !window.confirm('Discard this unsaved Pine draft?')) return;
    try {
      if (template && PINE_TEMPLATES.find((entry) => entry.id === templateId)?.kind === 'strategy' && !instrument) throw new Error('Wait for active instrument quote currency metadata before creating a strategy template.');
      const created = template ? createPineTemplate(templateId, instrument?.quoteCurrency ?? 'USD') : null;
      setSaved(null); setRevision(null); setRevisions([]); setName(created?.name ?? 'Untitled'); setSource(created?.source ?? EMPTY_SOURCE); setInputs({}); setProps({}); setValidation(null); setConflict(false); setError(null); setPlacement('declaration'); setDocumentKey(`new:${crypto.randomUUID()}`); booted.current = true;
      setNotice(created?.kind === 'strategy' ? `New strategy source fixes currency to ${instrument!.quoteCurrency}. Existing/imported source is not rewritten when you switch venues.` : 'New editable Pine draft. Save preserves an immutable revision.');
    } catch (failure) { fail(failure); }
  }
  async function importPine(file: File | undefined) {
    if (!file || (dirty && !window.confirm('Discard this unsaved draft and import Pine text?'))) return;
    setBusy(true);
    try {
      if (!/\.pine$/i.test(file.name)) throw new Error('Choose a .pine text file.');
      if (file.size > 262144) throw new Error('Pine source is limited to 256 KiB UTF-8.');
      const text = await file.text();
      if (pineSourceVersion(text) === null) throw new Error('Import Pine v5/v6 text with a //@version=5 or //@version=6 compiler annotation.');
      setSaved(null); setRevision(null); setRevisions([]); setName(file.name.replace(/\.pine$/i, '').slice(0, 100)); setSource(text); setInputs({}); setProps({}); setValidation(null); setConflict(false); setDocumentKey(`import:${crypto.randomUUID()}`); setNotice('Imported source unchanged. Validate before adding it to a chart.'); setError(null); booted.current = true;
    } catch (failure) { fail(failure); } finally { setBusy(false); }
  }

  return <div className="scripts-dock" hidden={tab === 'trading'}>
    <section className="pine-editor-panel" hidden={tab !== 'editor'} aria-label="Pine editor and editable script library">
      <div className="pine-toolbar">
        <label>Library<select aria-label="Pine script library" value={saved?.script.id ?? ''} disabled={busy} onChange={(event) => { if (event.target.value) void selectScript(event.target.value); }}>
          <option value="">Unsaved draft</option>
          {saved && !scripts.some((row) => row.id === saved.script.id) && <option value={saved.script.id}>{saved.script.name} · archived / removed from active library</option>}
          {scripts.map((row) => <option key={row.id} value={row.id}>{row.name} · r{row.revision}</option>)}
        </select></label>
        <label>Name<input aria-label="Script name" value={name} maxLength={100} disabled={busy} onChange={(event) => { setName(event.target.value); booted.current = true; }} /></label>
        <button type="button" onClick={() => newScript()} disabled={busy}>New script</button>
        <label>Template<select aria-label="Pine template" value={templateId} disabled={busy} onChange={(event) => setTemplateId(event.target.value)}>{PINE_TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button type="button" onClick={() => newScript(true)} disabled={busy}>New from template</button>
        <label className="pine-import">Import .pine<input aria-label="Import Pine file" type="file" accept=".pine,text/plain" disabled={busy} onChange={(event) => { void importPine(event.target.files?.[0]); event.target.value = ''; }} /></label>
        <button type="button" onClick={() => { const url = URL.createObjectURL(new Blob([source], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `${name || 'script'}.pine`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Export .pine</button>
      </div>
      <div className="pine-toolbar">
        <button type="button" className="primary" onClick={() => void action('save')} disabled={busy || conflict || !name.trim()}>Save</button>
        <button type="button" onClick={() => void action('copy')} disabled={busy || !name.trim()}>Save as copy</button>
        <button type="button" onClick={() => void action('validate')} disabled={busy}>Validate</button>
        <label>Placement<select aria-label="Indicator placement" value={placement} disabled={busy} onChange={(event) => setPlacement(event.target.value as typeof placement)}><option value="declaration">Source declaration</option><option value="overlay">Price overlay</option><option value="pane">Separate pane</option></select></label>
        <button type="button" onClick={() => void action('chart')} disabled={busy || !workspace}>Add to chart</button>
        <button type="button" onClick={() => void action('backtest')} disabled={busy || conflict || !active.market}>Backtest</button>
        <button type="button" onClick={() => void action('archive')} disabled={busy || !saved}>Archive</button>
        <span role="status">{busy ? 'Working…' : dirty ? 'Unsaved draft' : `Saved r${revision?.revision}`}</span>
        {saved && <label>Revision<select aria-label="Script revision history" value={revision?.id ?? ''} disabled={busy} onChange={(event) => { const selected = revisions.find((row) => row.id === event.target.value); if (selected && (!dirty || window.confirm('Discard this draft and restore the selected immutable revision?'))) restore(saved, selected); }}>{revisions.map((row) => <option value={row.id} key={row.id}>r{row.revision} · {new Date(row.createdAt).toISOString()}</option>)}</select></label>}
      </div>
      {error && <div className="pine-diagnostic" role="alert">{error}{conflict && <><button type="button" disabled={busy} onClick={() => { if (saved && window.confirm('Discard this local draft and reload latest server revision?')) void selectScript(saved.script.id, true); }}>Reload server revision</button><span>Save as copy preserves your draft; there is no force overwrite.</span></>}</div>}{notice && <p className="pine-notice" role="status">{notice}</p>}
      {validation?.diagnostics.map((diagnostic, index) => <p key={index} className="pine-diagnostic" role="alert">{diagnostic.code}: {diagnostic.message}{diagnostic.line === undefined ? '' : ` · line ${diagnostic.line}`}{diagnostic.column === undefined ? '' : `:${diagnostic.column}`}</p>)}
      {validation?.warnings?.map((warning, index) => <p key={index} className="pine-limitations">{warning.message}</p>)}
      <div className="pine-editor-grid">
        <PineEditor source={source} documentKey={documentKey} readOnly={busy} onChange={(text) => { setSource(text); setValidation(null); booted.current = true; }} />
        <div className="pine-inspector">
          <details><summary>Input / property overrides</summary><fieldset disabled={busy}><PineSettings validation={validation} inputs={inputs} props={props} onInputs={setInputs} onProps={setProps} /></fieldset></details>
          <details><summary>On-chart indicators · {handles.length}</summary>{handles.map((handle) => <div className="pine-handle" key={handle.id}>
            <strong>{handle.title}</strong><code>{handle.id}</code>
            <button type="button" onClick={() => { handle.setVisible(!handle.visible); setHandles([...workspace!.cell(active.cellId)!.chart.indicators()]); workspace!.root.dispatchEvent(new Event('pineterm:pine-state')); }}>{handle.visible ? 'Hide' : 'Show'}</button>
            <button type="button" onClick={() => { handle.moveTo('price'); workspace?.root.dispatchEvent(new Event('pineterm:pine-state')); }}>Overlay</button>
            <button type="button" onClick={() => { handle.moveTo({ newPane: true }); workspace?.root.dispatchEvent(new Event('pineterm:pine-state')); }}>Separate pane</button>
            <button type="button" onClick={() => { handle.remove(); setHandles([...workspace!.cell(active.cellId)!.chart.indicators()]); workspace!.root.dispatchEvent(new Event('pineterm:pine-state')); }}>Remove</button>
            {handle.source && <button type="button" disabled={busy} onClick={() => { if (!dirty || window.confirm('Replace this draft with the on-chart source?')) { setSaved(null); setRevision(null); setRevisions([]); setName(handle.title); setSource(handle.source!); setInputs(handle.inputValues()); setProps(handle.propValues()); setValidation(null); setDocumentKey(`chart:${handle.id}`); booted.current = true; } }}>Edit source / settings</button>}
          </div>)}</details>
          <details open={!!preview}><summary>Browser preview output</summary>{preview ? <><p>{preview.title} · {preview.kind} · bar {preview.bar} · {new Date(preview.time).toISOString()} · {preview.forming ? 'forming / provisional' : 'settled'} · {preview.complete ? 'full requested chart history' : 'backfill incomplete'}</p><pre>{JSON.stringify({ plots: preview.plots, strategy: preview.strategy ?? null }, null, 2)}</pre>{preview.warnings.map((warning, index) => <p className="pine-diagnostic" key={index}>{warning.message}</p>)}</> : <p>No computed preview. Add a valid script to the active chart.</p>}</details>
          <p className="muted">Browser workers provide responsiveness isolation, not a security sandbox. Preview values can use synthetic chart styles; durable backtests always use confirmed raw bars. CodeMirror supports editing, line numbers and Ctrl/Cmd-F search, not a complete Pine LSP.</p>
        </div>
      </div>
    </section>
    <div hidden={tab !== 'tester'}><StrategyTester client={client} revision={revision} sourceSaved={!!revision && source === revision.source} inputs={inputs} props={props} active={active} instrument={instrument} workspace={workspace} replayLocked={replayLocked} version={jobVersion} onError={fail} /></div>
  </div>;
}
