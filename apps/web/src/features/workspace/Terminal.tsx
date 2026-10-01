import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import type { Instrument, InvalidationEvent, MarketRef, Workspace } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import { ChartWorkspace } from './ChartWorkspace.js';
import type { ActiveChart } from './ChartWorkspace.js';
import { BackendMarketStream, PineTermProvider, feedKey, qualifiedMarket } from './PineTermProvider.js';
import type { FeedState } from './PineTermProvider.js';
import { DEFAULT_VELA_STATE, WorkspaceStorage } from './WorkspaceStorage.js';
import type { StorageSnapshot } from './WorkspaceStorage.js';
import { Watchlists } from './Watchlists.js';
import { DataSettings } from './DataSettings.js';

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
type RightTab = 'watchlists' | 'alerts' | 'agent';
type BottomTab = 'editor' | 'tester' | 'trading';
interface UiState { rightTab: RightTab; bottomTab: BottomTab; bottomHeight: number; watchlistId: string | null }
const INITIAL_UI: UiState = { rightTab: 'watchlists', bottomTab: 'editor', bottomHeight: 260, watchlistId: null };
const RIGHT_LABELS: Record<RightTab, string> = { watchlists: 'Watchlists', alerts: 'Alerts', agent: 'Agent' };
const BOTTOM_LABELS: Record<BottomTab, string> = { editor: 'Pine Editor', tester: 'Strategy Tester', trading: 'Trading' };

export function Terminal({ client, onSessionExpired, onConnection, onOpenSecurity, settingsOpen, onCloseSettings }: {
  client: ApiClient; onSessionExpired: () => void; onConnection: (state: string) => void; onOpenSecurity: () => void; settingsOpen: boolean; onCloseSettings: () => void;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [storage, setStorage] = useState<WorkspaceStorage | null>(null);
  const [saved, setSaved] = useState<StorageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [ui, setUi] = useState<UiState>(INITIAL_UI);
  const [feeds, setFeeds] = useState<Record<string, FeedState>>({});
  const [active, setActive] = useState<ActiveChart>({ cellId: 'c1', market: { provider: 'coinbase', symbol: 'BTC-USD' }, timeframe: '60', priceStyle: 'candles' });
  const [layout, setLayout] = useState('1');
  const [links, setLinks] = useState({ crosshair: true, symbol: false, timeframe: false, viewport: false });
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  const [drawer, setDrawer] = useState<'right' | 'bottom' | null>(null);
  const [watchlistVersion, setWatchlistVersion] = useState(0);
  const [resizing, setResizing] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const workspaceRef = useRef<VelaWorkspace | null>(null);
  const storageRef = useRef<WorkspaceStorage | null>(null);
  storageRef.current = storage;
  const bootstrap = useRef<Promise<Workspace[]> | null>(null);
  const dockRef = useRef<HTMLElement | null>(null);
  const drawerOrigin = useRef<HTMLElement | null>(null);
  const resizeStart = useRef({ y: 0, height: 260 });
  const uiRef = useRef(ui); uiRef.current = ui;
  const onSessionError = useCallback((_failure: ApiError) => onSessionExpired(), [onSessionExpired]);
  const [stream] = useState(() => new BackendMarketStream(client, onSessionError));
  const onFeed = useCallback((state: FeedState) => setFeeds((current) => ({ ...current, [feedKey(state.market, state.timeframe)]: state })), []);
  const onActiveChart = useCallback((chart: ActiveChart) => {
    setActive(chart);
    const workspace = workspaceRef.current;
    if (workspace) {
      setLayout(workspace.layout.id);
      setLinks({ crosshair: !!workspace.sync.get('crosshair'), symbol: !!workspace.sync.get('symbol'), timeframe: !!workspace.sync.get('timeframe'), viewport: !!workspace.sync.get('viewport') });
    }
  }, []);
  const onReady = useCallback((workspace: VelaWorkspace | null) => { workspaceRef.current = workspace; if (workspace) setLayout(workspace.layout.id); }, []);

  useEffect(() => {
    let alive = true;
    if (!bootstrap.current) bootstrap.current = client.request<{ workspaces: Workspace[] }>('/workspaces').then(async ({ workspaces: records }) => {
      if (records.length) return records;
      const { workspace } = await client.request<{ workspace: Workspace }>('/workspaces', { method: 'POST', csrf: true, body: { name: 'My workspace', velaState: DEFAULT_VELA_STATE, uiState: INITIAL_UI } });
      return [workspace];
    });
    void bootstrap.current.then((records) => {
      if (!alive) return;
      setWorkspaces(records);
      let id: string | null = null; try { id = localStorage.getItem('pineterm.activeWorkspace'); } catch { /* Selection persistence is optional. */ }
      const record = records.find((item) => item.id === id) ?? records[0]!;
      setStorage(new WorkspaceStorage(client, record, onSessionError));
    }).catch((failure: unknown) => {
      if (!alive) return;
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
      setError(errorMessage(failure));
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [client, onSessionError]);

  useEffect(() => {
    if (!storage) return;
    const snapshot = storage.snapshot();
    const value = snapshot.uiState;
    const restored: UiState = {
      rightTab: ['watchlists', 'alerts', 'agent'].includes(String(value.rightTab)) ? value.rightTab as RightTab : 'watchlists',
      bottomTab: ['editor', 'tester', 'trading'].includes(String(value.bottomTab)) ? value.bottomTab as BottomTab : 'editor',
      bottomHeight: typeof value.bottomHeight === 'number' && Number.isFinite(value.bottomHeight) ? Math.max(120, Math.min(500, value.bottomHeight)) : 260,
      watchlistId: typeof value.watchlistId === 'string' ? value.watchlistId : null,
    };
    setUi(restored); setName(''); setNotice(null);
    try { localStorage.setItem('pineterm.activeWorkspace', snapshot.workspace.id); } catch { /* The server remains authoritative. */ }
    const stop = storage.subscribe((next) => {
      setSaved(next);
      setWorkspaces((records) => records.map((record) => record.id === next.workspace.id ? next.workspace : record));
    });
    return () => {
      const workspace = workspaceRef.current;
      if (workspace) storage.set(storage.key, JSON.stringify(workspace.getState()));
      stop(); storage.dispose();
    };
  }, [storage]);

  useEffect(() => {
    const source = new EventSource('/api/v1/events');
    let connected = false;
    const refresh = () => {
      void client.request<{ workspaces: Workspace[] }>('/workspaces').then(({ workspaces: records }) => setWorkspaces(records)).catch((failure: unknown) => {
        if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
        setError(errorMessage(failure));
      });
      setWatchlistVersion((value) => value + 1);
    };
    source.onopen = () => { if (connected) refresh(); connected = true; };
    source.addEventListener('invalidation', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as InvalidationEvent;
      if (data.type === 'workspaces.changed') refresh();
      else if (data.type === 'watchlists.changed') setWatchlistVersion((value) => value + 1);
    });
    return () => source.close();
  }, [client, onSessionError]);
  useEffect(() => () => stream.dispose(), [stream]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const change = () => { setCompact(media.matches); setDrawer(null); };
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!compact || !drawer || !dockRef.current) return;
    const dock = dockRef.current;
    const close = dock.querySelector<HTMLButtonElement>('.dock-close'); close?.focus();
    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setDrawer(null); drawerOrigin.current?.focus(); }
      if (event.key === 'Tab') {
        const elements = Array.from(dock.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')).filter((element) => element.getClientRects().length);
        const first = elements[0]; const last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keyboard); return () => document.removeEventListener('keydown', keyboard);
  }, [compact, drawer]);
  useEffect(() => {
    if (!resizing) return;
    const move = (event: globalThis.PointerEvent) => {
      const height = Math.max(120, Math.min(500, resizeStart.current.height + resizeStart.current.y - event.clientY));
      setUi((current) => ({ ...current, bottomHeight: height }));
    };
    const stop = () => {
      setResizing(false);
      storageRef.current?.updateUi({ ...storageRef.current.snapshot().uiState, ...uiRef.current });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop, { once: true }); window.addEventListener('pointercancel', stop, { once: true });
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
  }, [resizing]);
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      const status = storageRef.current?.snapshot().status;
      if (status && status !== 'Saved') { event.preventDefault(); }
    };
    window.addEventListener('beforeunload', preventLoss); return () => window.removeEventListener('beforeunload', preventLoss);
  }, []);

  const updateUi = useCallback((change: Partial<UiState>) => {
    const next = { ...uiRef.current, ...change }; setUi(next); uiRef.current = next;
    const current = storageRef.current;
    current?.updateUi({ ...current.snapshot().uiState, ...next });
  }, []);
  const onSelectList = useCallback((id: string) => updateUi({ watchlistId: id }), [updateUi]);
  const selectMarket = useCallback((market: MarketRef, preferredTimeframe?: string) => {
    void (async () => {
      const workspace = workspaceRef.current; if (!workspace) return;
      try {
        const params = new URLSearchParams({ provider: market.provider, q: market.symbol });
        const { markets } = await client.request<{ markets: Instrument[] }>(`/markets?${params}`);
        const instrument = markets.find((item) => item.market.symbol === market.symbol);
        if (!instrument) throw new Error('The selected market is no longer available from its provider.');
        const currentTimeframe = preferredTimeframe ?? workspace.active.chart.market.timeframe ?? '60';
        const timeframe = instrument.timeframes.includes(currentTimeframe) ? currentTimeframe : instrument.timeframes[0]!;
        await workspace.chart.setMarket({ symbol: qualifiedMarket(market), timeframe });
        setDrawer(null); workspace.active.focus();
      } catch (failure) {
        if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
        setError(errorMessage(failure));
      }
    })();
  }, [client, onSessionError]);

  async function changeWorkspace(id: string, discard = false) {
    if (!storage || busy) return;
    setBusy(true); setError(null);
    try {
      const workspace = workspaceRef.current;
      if (workspace) storage.set(storage.key, JSON.stringify(workspace.getState()));
      if (!discard) await storage.flush();
      const { workspace: record } = await client.request<{ workspace: Workspace }>(`/workspaces/${id}`);
      if (discard) storage.discardLocalDraft();
      setStorage(new WorkspaceStorage(client, record, onSessionError));
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
      setError(errorMessage(failure));
    } finally { setBusy(false); }
  }
  async function workspaceCommand(action: 'new' | 'copy' | 'rename' | 'delete' | 'flush') {
    if (!storage || busy) return;
    setBusy(true); setError(null);
    try {
      const workspace = workspaceRef.current;
      if (workspace) storage.set(storage.key, JSON.stringify(workspace.getState()));
      if (action === 'flush') await storage.flush();
      else if (action === 'rename') { storage.rename(name.trim()); await storage.flush(); setName(''); }
      else if (action === 'delete') {
        if (!['Conflict', 'Invalid'].includes(storage.snapshot().status)) await storage.flush();
        const id = storage.snapshot().workspace.id;
        await client.request<void>(`/workspaces/${id}`, { method: 'DELETE', csrf: true });
        storage.discardLocalDraft();
        let remaining = workspaces.filter((record) => record.id !== id);
        if (!remaining.length) {
          const { workspace: created } = await client.request<{ workspace: Workspace }>('/workspaces', { method: 'POST', csrf: true, body: { name: 'My workspace', velaState: DEFAULT_VELA_STATE, uiState: INITIAL_UI } });
          remaining = [created];
        }
        const { workspace: record } = await client.request<{ workspace: Workspace }>(`/workspaces/${remaining[0]!.id}`);
        setWorkspaces(remaining); setStorage(new WorkspaceStorage(client, record, onSessionError));
      } else {
        let record: Workspace;
        if (action === 'copy') record = await storage.saveAsCopy(name.trim());
        else {
          await storage.flush();
          const result = await client.request<{ workspace: Workspace }>('/workspaces', { method: 'POST', csrf: true, body: { name: name.trim(), velaState: DEFAULT_VELA_STATE, uiState: INITIAL_UI } });
          record = result.workspace;
        }
        setWorkspaces((current) => [...current, record]); setStorage(new WorkspaceStorage(client, record, onSessionError));
      }
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
      setError(errorMessage(failure));
    } finally { setBusy(false); }
  }
  async function exportCsv() {
    if (!active.market) return;
    setError(null); setBusy(true);
    try {
      const params = new URLSearchParams({ provider: active.market.provider, symbol: active.market.symbol, timeframe: active.timeframe, limit: '5000' });
      for (const [field, value] of [['from', from], ['to', to]]) if (value) params.set(field!, String(Date.parse(`${value}Z`)));
      const blob = await client.request<Blob>(`/bars.csv?${params}`, { responseType: 'blob' });
      downloadBlob(blob, `${active.market.provider}-${active.market.symbol}-${active.timeframe}.csv`);
      setNotice('Downloaded authoritative raw OHLCV, not synthetic chart prices.');
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
      setError(errorMessage(failure));
    } finally { setBusy(false); }
  }
  function openDock(which: 'right' | 'bottom', tab?: RightTab | BottomTab) {
    drawerOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (tab) updateUi(which === 'right' ? { rightTab: tab as RightTab } : { bottomTab: tab as BottomTab });
    setDrawer(which);
  }
  function resizeKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault(); updateUi({ bottomHeight: Math.max(120, Math.min(500, ui.bottomHeight + (event.key === 'ArrowUp' ? 16 : -16))) });
  }
  function resizePointer(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault(); resizeStart.current = { y: event.clientY, height: ui.bottomHeight }; setResizing(true);
  }
  const feed = active.market ? feeds[feedKey(active.market, active.timeframe)] : undefined;
  useEffect(() => { onConnection(feed ? `Feed ${feed.kind}` : 'Feed connecting'); }, [feed, onConnection]);
  const invalid = saved?.status === 'Invalid';
  const conflict = saved?.status === 'Conflict';
  const unsaved = saved && saved.status !== 'Saved';
  const newer = saved && workspaces.find((record) => record.id === saved.workspace.id)?.revision !== saved.workspace.revision;

  return <div className="terminal" style={{ '--bottom-height': `${ui.bottomHeight}px` } as CSSProperties}>
    <div className="workspace-controls">
      <label htmlFor="workspace-select">Workspace</label><select id="workspace-select" aria-label="Workspace" value={saved?.workspace.id ?? ''} disabled={busy || loading || !storage} onChange={(event) => void changeWorkspace(event.target.value)}>{workspaces.map((record) => <option key={record.id} value={record.id}>{record.name}</option>)}</select>
      <span className={`save-indicator ${unsaved ? 'warning' : ''}`} role="status">{loading ? 'Loading…' : saved?.status ?? 'Unavailable'}</span>
      <button type="button" onClick={() => void workspaceCommand('flush')} disabled={busy || !storage || invalid || conflict}>Flush</button>
      <details className="workspace-menu"><summary>Manage workspace</summary><div className="workspace-menu-content"><label htmlFor="workspace-name">Workspace name</label><input id="workspace-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="Name or copy name" />
        <div className="compact-actions"><button type="button" disabled={busy || !name.trim() || invalid || conflict} onClick={() => void workspaceCommand('new')}>New</button><button type="button" disabled={busy || !name.trim() || invalid} onClick={() => void workspaceCommand('copy')}>Save as copy</button><button type="button" disabled={busy || !name.trim() || invalid || conflict} onClick={() => void workspaceCommand('rename')}>Rename</button><button type="button" className="danger" disabled={busy || !storage} onClick={() => { if (window.confirm(`Delete “${saved?.workspace.name}” and its unsaved draft?`)) void workspaceCommand('delete'); }}>Delete</button></div>
      </div></details>
      <label htmlFor="layout-select">Layout</label><select id="layout-select" aria-label="Layout" value={layout} disabled={!workspaceRef.current || invalid} onChange={(event) => { workspaceRef.current?.setLayout(event.target.value); }}><option value="1">1 chart</option><option value="2h">2 horizontal</option><option value="2v">2 vertical</option><option value="4">4 charts</option><option value="8">8 charts</option>{!['1', '2h', '2v', '4', '8'].includes(layout) && <option value={layout}>{layout}</option>}</select>
      <details className="link-menu"><summary>Chart links</summary><fieldset>{(['crosshair', 'symbol', 'timeframe', 'viewport'] as const).map((kind) => <label key={kind}><input type="checkbox" checked={links[kind]} onChange={(event) => { workspaceRef.current?.sync.set(kind, event.target.checked); setLinks((current) => ({ ...current, [kind]: event.target.checked })); }} />{kind[0]!.toUpperCase() + kind.slice(1)}</label>)}</fieldset></details>
      <details className="export-menu"><summary>Export</summary><div className="export-menu-content"><label htmlFor="export-from">From · UTC inclusive</label><input id="export-from" type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /><label htmlFor="export-to">To · UTC exclusive</label><input id="export-to" type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} /><button type="button" onClick={() => void exportCsv()} disabled={busy || !active.market}>Download raw CSV</button><small>Newest 5,000 bars in the selected range.</small><button type="button" onClick={() => { const workspace = workspaceRef.current; if (!workspace?.screenshot()) setError('Chart image is unavailable until the renderer is ready.'); else workspace.downloadScreenshot(); }}>Download chart PNG</button><small>Vela chart raster: drawing layers are included; DOM overlays are best-effort. Outer docks, dialogs and application chrome are not a full-browser screenshot.</small></div></details>
      <div className="dock-actions"><button type="button" onClick={() => openDock('right')}>Watchlists / tools</button><button type="button" onClick={() => openDock('bottom')}>Editor / trading</button></div>
    </div>
    {(error || saved?.message || notice || newer) && <div className={`terminal-notice ${error || invalid || conflict ? 'error' : ''}`} role={error || invalid || conflict ? 'alert' : 'status'}>
      <span>{error ?? saved?.message ?? notice ?? 'A newer server revision is available. Reload to view it.'}</span>
      {(conflict || invalid || newer) && <button type="button" disabled={busy} onClick={() => { if (window.confirm('Discard this local draft and reload the server copy?')) void changeWorkspace(saved!.workspace.id, true); }}>Reload server</button>}
      {saved && <button type="button" onClick={() => { if (storage) downloadBlob(storage.original(), `${saved.workspace.name}-workspace.json`); }}>Download {invalid ? 'original state' : 'draft'}</button>}
      {conflict && <span>Use Manage workspace → Save as copy to preserve both versions.</span>}
      {error && <button type="button" onClick={() => setError(null)}>Dismiss</button>}
    </div>}
    <div className="terminal-body">
      <section className="chart-region" aria-label="Chart workspace">
        {storage && !invalid ? <ChartWorkspace key={storage.key} client={client} storage={storage} stream={stream} feeds={feeds} onFeed={onFeed} onSessionError={onSessionError} onReady={onReady} onActiveChart={onActiveChart} /> : <div className="chart-unavailable"><h1>{invalid ? 'Saved chart state needs attention' : loading ? 'Opening your workspace…' : 'Workspace unavailable'}</h1><p>{invalid ? 'No fields have been silently discarded. Download the original state before modifying or deleting this workspace.' : error ?? 'Waiting for the PineTerm server.'}</p></div>}
      </section>
      {compact && drawer && <button className="dock-backdrop" aria-label="Close open drawer" onClick={() => { setDrawer(null); drawerOrigin.current?.focus(); }} />}
      <aside className={`right-dock dock ${drawer === 'right' ? 'is-open' : ''}`} ref={(element) => { if (drawer === 'right') dockRef.current = element; }} role={compact && drawer === 'right' ? 'dialog' : undefined} aria-modal={compact && drawer === 'right' ? true : undefined} aria-label="Watchlists, alerts and agent tools">
        <div className="dock-tabs" role="tablist" aria-label="Right dock">{(['watchlists', 'alerts', 'agent'] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={ui.rightTab === tab} onClick={() => updateUi({ rightTab: tab })}>{RIGHT_LABELS[tab]}</button>)}<button type="button" className="dock-close" onClick={() => { setDrawer(null); drawerOrigin.current?.focus(); }}>Close</button></div>
        <div className="dock-content" role="tabpanel">{ui.rightTab === 'watchlists' ? <Watchlists client={client} stream={stream} onSelectMarket={selectMarket} onSessionError={onSessionError} selectedId={ui.watchlistId} onSelectList={onSelectList} version={watchlistVersion} /> : <section className="unavailable-feature"><span className="eyebrow">Not yet available</span><h2>{ui.rightTab === 'alerts' ? 'Durable alerts' : 'Pi agent'}</h2><p>{ui.rightTab === 'alerts' ? 'Server-backed price and Pine alerts, signed webhooks and Telegram will arrive in milestone 6. No durable alert is armed by this chart preview.' : 'Grounded market analysis and Pine authoring arrive in milestone 8. No model has been configured and no canned analysis is shown.'}</p></section>}</div>
      </aside>
      <section className={`bottom-dock dock ${drawer === 'bottom' ? 'is-open' : ''}`} ref={(element) => { if (drawer === 'bottom') dockRef.current = element; }} role={compact && drawer === 'bottom' ? 'dialog' : undefined} aria-modal={compact && drawer === 'bottom' ? true : undefined} aria-label="Pine editor, strategy tester and trading">
        <div className={`bottom-resizer ${resizing ? 'is-resizing' : ''}`} role="separator" tabIndex={0} aria-label="Resize bottom dock" aria-orientation="horizontal" aria-valuemin={120} aria-valuemax={500} aria-valuenow={Math.round(ui.bottomHeight)} onPointerDown={resizePointer} onKeyDown={resizeKeyboard} />
        <div className="dock-tabs" role="tablist" aria-label="Bottom dock">{(['editor', 'tester', 'trading'] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={ui.bottomTab === tab} onClick={() => updateUi({ bottomTab: tab })}>{BOTTOM_LABELS[tab]}</button>)}<span className="dock-context">{active.market ? qualifiedMarket(active.market) : 'No instrument'} · {active.timeframe}</span><button type="button" className="dock-close" onClick={() => { setDrawer(null); drawerOrigin.current?.focus(); }}>Close</button></div>
        <div className="dock-content" role="tabpanel"><section className="unavailable-feature"><span className="eyebrow">Not yet available</span><h2>{BOTTOM_LABELS[ui.bottomTab]}</h2><p>{ui.bottomTab === 'editor' ? 'Saved Pine scripts and the editable library arrive in milestone 4. Vela’s chart tools and native volume are available now; this pane does not pretend to run an editor.' : ui.bottomTab === 'tester' ? 'No backtest results. Isolated PineTS strategy simulation and reproducible result provenance arrive in milestone 4.' : 'Paper accounts and server-authoritative replay arrive in milestone 5. No orders, balances or portfolio gains are fabricated. Live executor handoff is disabled.'}</p><div className="feature-boundaries"><span>Venue-qualified data</span><span>Raw bars remain authoritative</span><span>Execution disabled</span></div></section></div>
      </section>
    </div>
    <div className="terminal-status" role="status"><span className={`connection-state ${feed?.kind === 'live' ? 'positive' : feed?.kind === 'unavailable' ? 'negative' : 'muted'}`}>● {feed?.kind ?? 'Connecting'}</span><span>{active.market ? qualifiedMarket(active.market) : 'No instrument'} · {active.timeframe}</span><span title={feed?.message}>{feed?.asOf ? `Observed ${new Date(feed.asOf).toLocaleTimeString()}` : feed?.message ?? 'Awaiting authoritative data'}{feed?.gaps ? ` · ${feed.gaps} data gaps` : ''}</span><span>{saved?.status ?? 'Unsaved'} · live handoff disabled</span></div>
    <nav className="mobile-navigation" aria-label="Terminal views"><button type="button" onClick={() => setDrawer(null)} aria-pressed={!drawer}>Chart</button><button type="button" onClick={() => openDock('right', 'watchlists')} aria-pressed={drawer === 'right' && ui.rightTab === 'watchlists'}>Watchlists</button><button type="button" onClick={() => openDock('bottom', 'editor')} aria-pressed={drawer === 'bottom' && ui.bottomTab === 'editor'}>Editor</button><button type="button" onClick={() => openDock('bottom', 'trading')} aria-pressed={drawer === 'bottom' && ui.bottomTab === 'trading'}>Trading</button><button type="button" onClick={() => openDock('right', 'agent')} aria-pressed={drawer === 'right' && ui.rightTab === 'agent'}>Agent</button></nav>
    {settingsOpen && <DataSettings client={client} onClose={onCloseSettings} onOpenSecurity={onOpenSecurity} onSessionError={onSessionError} onDatasetImported={(market, timeframe) => {
      const workspace = workspaceRef.current;
      const provider = workspace?.chart.data.providerInstance('csv');
      if (provider instanceof PineTermProvider) workspace!.chart.data.registerProvider('csv', provider);
      selectMarket(market, timeframe);
    }} />}
  </div>;
}
