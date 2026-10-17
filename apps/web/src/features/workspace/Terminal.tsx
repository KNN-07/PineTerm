import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { registerWidgetAction } from '@luxalgo/vela/widget';
import { registerIcon, svg16 } from '@luxalgo/vela/ui';
import type { AppliedAgentDraft, Instrument, InvalidationEvent, MarketRef, ReplaySession, Workspace } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import { SOURCE_URL } from '../../About.js';
import { Dropdown, MenuItem } from '../../Dropdown.js';
import { Icon, VELA_ICON_BODIES } from '../../icons.js';
import type { IconName } from '../../icons.js';
import { ChartWorkspace } from './ChartWorkspace.js';
import type { ActiveChart } from './ChartWorkspace.js';
import { BackendMarketStream, PineTermProvider, feedKey, qualifiedMarket } from './PineTermProvider.js';
import type { FeedState } from './PineTermProvider.js';
import { DEFAULT_VELA_STATE, WorkspaceStorage } from './WorkspaceStorage.js';
import type { StorageSnapshot } from './WorkspaceStorage.js';
import { Watchlists } from './Watchlists.js';
import { DataSettings } from './DataSettings.js';
import { ScriptsDock } from '../scripts/ScriptsDock.js';
import { TradingPanel } from '../trading/TradingPanel.js';
import { ReplayControls } from '../trading/ReplayControls.js';
import type { WorkspaceReplayBridge } from '../trading/WorkspaceReplayBridge.js';
import { AlertPanel } from '../alerts/AlertPanel.js';
import { ExternalTradingPanel } from '../execution/ExternalTradingPanel.js';
import { ExecutionStatus, useExecution } from '../execution/ExecutionContext.js';
import { AgentPanel } from '../agent/AgentPanel.js';
import type { AgentScriptSelection } from '../agent/AgentPanel.js';

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
type RightTab = 'watchlists' | 'alerts' | 'agent';
type BottomTab = 'editor' | 'tester' | 'trading';
interface UiState { rightTab: RightTab; panelOpen: boolean; panelWidth: number; bottomTab: BottomTab; bottomHeight: number; bottomCollapsed: boolean; watchlistId: string | null }
const INITIAL_UI: UiState = { rightTab: 'watchlists', panelOpen: true, panelWidth: 320, bottomTab: 'editor', bottomHeight: 300, bottomCollapsed: false, watchlistId: null };
const RIGHT_TABS: Array<{ id: RightTab; label: string; icon: IconName }> = [
  { id: 'watchlists', label: 'Watchlist', icon: 'watchlist' },
  { id: 'alerts', label: 'Alerts', icon: 'alarm' },
  { id: 'agent', label: 'Pi agent', icon: 'agent' },
];
const BOTTOM_LABELS: Record<BottomTab, string> = { editor: 'Pine Editor', tester: 'Strategy Tester', trading: 'Trading Panel' };
const STRIP_WIDTH = 46;
const clampHeight = (value: number) => Math.max(120, Math.min(640, value));
const clampWidth = (value: number) => Math.max(240, Math.min(560, value));

// Header actions join Vela's own topbar beside Indicators, the way Alert and Replay sit in a TradingView header.
const topbarHandlers = { alert: () => {}, replay: () => {} };
for (const [id, body] of Object.entries(VELA_ICON_BODIES)) registerIcon(id, svg16(body));
registerWidgetAction({ id: 'pineterm.alert', target: 'topbar', align: 'left', order: 10, label: 'Alert', icon: 'pineterm-alarm', run: () => topbarHandlers.alert() });
registerWidgetAction({ id: 'pineterm.replay', target: 'topbar', align: 'left', order: 20, label: 'Replay', icon: 'pineterm-replay', run: () => topbarHandlers.replay() });

export function Terminal({ client, onSessionExpired, onConnection, onOpenSettings, onOpenSecurity, onOpenNotifications, onOpenExecution, onOpenAgent, onOpenAbout, onSignOut, signingOut, agentConfigVersion, settingsOpen, onCloseSettings }: {
  client: ApiClient; onSessionExpired: () => void; onConnection: (state: string) => void; onOpenSettings: () => void; onOpenSecurity: () => void; onOpenNotifications: () => void; onOpenExecution: () => void; onOpenAgent: () => void;
  onOpenAbout: () => void; onSignOut: () => void; signingOut: boolean; agentConfigVersion: number; settingsOpen: boolean; onCloseSettings: () => void;
}) {
  const { policy: executionPolicy, notice: executionNotice } = useExecution();
  const [selectedIntentId, setSelectedIntentId] = useState<string | null>(null);
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
  const [viewportLinked, setViewportLinked] = useState(false);
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  const [drawer, setDrawer] = useState<'right' | 'bottom' | null>(null);
  const [watchlistVersion, setWatchlistVersion] = useState(0);
  const [resizing, setResizing] = useState<'bottom' | 'panel' | null>(null);
  const [bottomMaximized, setBottomMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayStrip, setReplayStrip] = useState<HTMLElement | null>(null);
  const [alertRequested, setAlertRequested] = useState(false);
  const [headerRightWidth, setHeaderRightWidth] = useState(0);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const workspaceRef = useRef<VelaWorkspace | null>(null);
  const [pineWorkspace, setPineWorkspace] = useState<VelaWorkspace | null>(null);
  const [replayBridge, setReplayBridge] = useState<WorkspaceReplayBridge | null>(null);
  const [replaySession, setReplaySession] = useState<ReplaySession | null>(null);
  const [replayLocked, setReplayLocked] = useState(false);
  const [replayReady, setReplayReady] = useState(false);
  const [agentScript, setAgentScript] = useState<AgentScriptSelection>({ revisionId: null, name: null, sourceSaved: false, diagnostic: null });
  const [agentPaperAccountId, setAgentPaperAccountId] = useState<string | null>(null);
  const [appliedAgentDraft, setAppliedAgentDraft] = useState<AppliedAgentDraft | null>(null);
  const replayLockRef = useRef(false);
  const onReplayLock = useCallback((locked: boolean) => { replayLockRef.current = locked; setReplayLocked(locked); }, []);
  const storageRef = useRef<WorkspaceStorage | null>(null);
  storageRef.current = storage;
  const bootstrap = useRef<Promise<Workspace[]> | null>(null);
  const dockRef = useRef<HTMLElement | null>(null);
  const drawerOrigin = useRef<HTMLElement | null>(null);
  const headerRight = useRef<HTMLDivElement>(null);
  const resizeStart = useRef({ x: 0, y: 0, height: 300, width: 320 });
  const uiRef = useRef(ui); uiRef.current = ui;
  const onSessionError = useCallback((_failure: ApiError) => onSessionExpired(), [onSessionExpired]);
  const [stream] = useState(() => new BackendMarketStream(client, onSessionError));
  const onFeed = useCallback((state: FeedState) => setFeeds((current) => ({ ...current, [feedKey(state.market, state.timeframe)]: state })), []);
  const onActiveChart = useCallback((chart: ActiveChart) => {
    setActive(chart);
    const workspace = workspaceRef.current;
    if (workspace) setViewportLinked(!!workspace.sync.get('viewport'));
  }, []);
  const onReady = useCallback((workspace: VelaWorkspace | null, bridge: WorkspaceReplayBridge | null) => { workspaceRef.current = workspace; setPineWorkspace(workspace); setReplayBridge(bridge); }, []);
  const onAlertHandled = useCallback(() => setAlertRequested(false), []);

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
      panelOpen: typeof value.panelOpen === 'boolean' ? value.panelOpen : true,
      panelWidth: typeof value.panelWidth === 'number' && Number.isFinite(value.panelWidth) ? clampWidth(value.panelWidth) : INITIAL_UI.panelWidth,
      bottomTab: ['editor', 'tester', 'trading'].includes(String(value.bottomTab)) ? value.bottomTab as BottomTab : 'editor',
      bottomHeight: typeof value.bottomHeight === 'number' && Number.isFinite(value.bottomHeight) ? clampHeight(value.bottomHeight) : INITIAL_UI.bottomHeight,
      bottomCollapsed: typeof value.bottomCollapsed === 'boolean' ? value.bottomCollapsed : false,
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
    const change = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', change); return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  useLayoutEffect(() => {
    const element = headerRight.current?.firstElementChild;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeaderRightWidth(Math.ceil(element.getBoundingClientRect().width)));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    // Replay owns a strip inside Vela's shell, between the charts and the range bar.
    if (!pineWorkspace) { setReplayStrip(null); return; }
    const element = document.createElement('div');
    element.className = 'pineterm-strip';
    const undock = pineWorkspace.context().dockStrip(element);
    setReplayStrip(element);
    return () => { undock(); setReplayStrip(null); };
  }, [pineWorkspace]);
  useEffect(() => {
    if (!compact || !drawer || !dockRef.current) return;
    const dock = dockRef.current;
    const close = dock.querySelector<HTMLButtonElement>('.dock-close'); close?.focus();
    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') { event.preventDefault(); setDrawer(null); drawerOrigin.current?.focus(); }
      if (event.key === 'Tab') {
        const elements = Array.from(dock.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]')).filter((element) => element.getClientRects().length);
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
      const start = resizeStart.current;
      setUi((current) => resizing === 'bottom'
        ? { ...current, bottomHeight: clampHeight(start.height + start.y - event.clientY) }
        : { ...current, panelWidth: clampWidth(start.width + start.x - event.clientX) });
    };
    const stop = () => {
      setResizing(null);
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
      const workspace = workspaceRef.current; if (!workspace || replayLockRef.current) return;
      try {
        const params = new URLSearchParams({ provider: market.provider, q: market.symbol });
        const { markets } = await client.request<{ markets: Instrument[] }>(`/markets?${params}`);
        const instrument = markets.find((item) => item.market.symbol === market.symbol);
        if (!instrument) throw new Error('The selected market is no longer available from its provider.');
        const currentTimeframe = preferredTimeframe ?? workspace.active.chart.market.timeframe ?? '60';
        const timeframe = instrument.timeframes.includes(currentTimeframe) ? currentTimeframe : instrument.timeframes[0]!;
        if (replayLockRef.current) return;
        await workspace.chart.setMarket({ symbol: qualifiedMarket(market), timeframe });
        setDrawer(null); workspace.active.focus();
      } catch (failure) {
        if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
        setError(errorMessage(failure));
      }
    })();
  }, [client, onSessionError]);

  async function changeWorkspace(id: string, discard = false) {
    if (!storage || busy || replayLockRef.current) return;
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
    if (!storage || busy || replayLockRef.current) return;
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
      if (replaySession) params.set('replaySessionId', replaySession.id);
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
    if (tab) updateUi(which === 'right' ? { rightTab: tab as RightTab, panelOpen: true } : { bottomTab: tab as BottomTab, bottomCollapsed: false });
    setDrawer(which);
  }
  /** TradingView's widget bar: pressing the open widget's icon folds the panel away. */
  function toggleRightTab(tab: RightTab) {
    if (ui.panelOpen && ui.rightTab === tab) updateUi({ panelOpen: false });
    else updateUi({ rightTab: tab, panelOpen: true });
  }
  /** Pressing the selected bottom tab folds the panel to its tab bar, as TradingView does. */
  function selectBottomTab(tab: BottomTab) {
    if (!compact && tab === ui.bottomTab && !ui.bottomCollapsed) { updateUi({ bottomCollapsed: true }); setBottomMaximized(false); }
    else updateUi({ bottomTab: tab, bottomCollapsed: false });
  }
  function openRight(tab: RightTab) {
    if (compact) openDock('right', tab); else updateUi({ rightTab: tab, panelOpen: true });
  }
  function openBottom(tab: BottomTab) {
    if (compact) openDock('bottom', tab); else updateUi({ bottomTab: tab, bottomCollapsed: false });
  }
  topbarHandlers.alert = () => { openRight('alerts'); setAlertRequested(true); };
  topbarHandlers.replay = () => setReplayOpen((value) => !value);
  function bottomResizeKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault(); updateUi({ bottomHeight: clampHeight(ui.bottomHeight + (event.key === 'ArrowUp' ? 16 : -16)) });
  }
  function panelResizeKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); updateUi({ panelWidth: clampWidth(ui.panelWidth + (event.key === 'ArrowLeft' ? 16 : -16)) });
  }
  function startResize(kind: 'bottom' | 'panel', event: PointerEvent<HTMLDivElement>) {
    event.preventDefault(); resizeStart.current = { x: event.clientX, y: event.clientY, height: ui.bottomHeight, width: ui.panelWidth }; setResizing(kind);
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch((failure: unknown) => setError(`Fullscreen unavailable: ${errorMessage(failure)}`));
  }
  const closeDrawer = () => { setDrawer(null); drawerOrigin.current?.focus(); };
  const feed = active.market ? feeds[feedKey(active.market, active.timeframe)] : undefined;
  useEffect(() => { onConnection(feed ? `Feed ${feed.kind}` : 'Feed connecting'); }, [feed, onConnection]);
  useEffect(() => {
    // Like a TradingView tab: the active symbol and layout name lead the browser title.
    document.title = `${active.market?.symbol ?? 'PineTerm'}${saved ? ` · ${saved.workspace.name}` : ''} — PineTerm`;
    return () => { document.title = 'PineTerm — self-hosted workspace'; };
  }, [active.market?.symbol, saved?.workspace.name]);
  const invalid = saved?.status === 'Invalid';
  const conflict = saved?.status === 'Conflict';
  const unsaved = saved && saved.status !== 'Saved';
  const newer = saved && workspaces.find((record) => record.id === saved.workspace.id)?.revision !== saved.workspace.revision;
  const marketLabel = active.market ? qualifiedMarket(active.market) : 'No instrument';
  const feedTone = feed?.kind === 'live' ? 'positive' : feed?.kind === 'unavailable' || feed?.kind === 'disconnected' ? 'negative' : feed?.kind === 'stale' || feed?.kind === 'empty' ? 'warning' : 'muted';
  const observed = feed?.asOf ? `Observed ${new Date(feed.asOf).toLocaleTimeString()}` : feed?.message ?? 'Awaiting authoritative data';
  const panelVisible = !compact && ui.panelOpen;
  const rightWidth = compact ? 0 : STRIP_WIDTH + (ui.panelOpen ? ui.panelWidth : 0);
  const bottomRows = bottomMaximized && !ui.bottomCollapsed ? '120px minmax(0, 1fr)' : `minmax(0, 1fr) ${ui.bottomCollapsed ? 'var(--tab-bar-h)' : `${ui.bottomHeight}px`}`;

  return <div className={`terminal ${compact ? 'is-compact' : ''}`} style={{ '--right-w': `${rightWidth}px`, '--hdr-right-w': `${headerRightWidth}px` } as CSSProperties}>
    <header className="tv-header">
      <div className="tv-header-left">
        <Dropdown className="app-menu" buttonClassName="brand-button" title="PineTerm menu" ariaLabel="PineTerm menu" label={<span className="brand-mark" aria-hidden="true">P</span>}>{(close) => <>
          <div className="tv-menu-heading"><strong>PineTerm</strong><span>Self-hosted charting workspace</span></div>
          <MenuItem icon={<Icon name="gear" />} onSelect={() => { close(); onOpenSettings(); }}>Settings</MenuItem>
          <MenuItem icon={<Icon name="info" />} onSelect={() => { close(); onOpenAbout(); }}>About PineTerm</MenuItem>
          <a className="tv-menu-item" href={SOURCE_URL} target="_blank" rel="noopener noreferrer"><span className="tv-menu-icon"><Icon name="code" /></span><span className="tv-menu-label">Source code</span><span className="tv-menu-hint"><Icon name="external" size={14} /></span></a>
          <div className="tv-menu-separator" />
          <MenuItem icon={<Icon name="signOut" />} disabled={signingOut} onSelect={() => { close(); onSignOut(); }}>{signingOut ? 'Signing out…' : 'Sign out'}</MenuItem>
          <p className="tv-menu-footnote">PineTerm · AGPL-3.0-only · Charts by <a href="https://velacharts.dev" target="_blank" rel="noopener noreferrer">Vela by LuxAlgo</a></p>
        </>}</Dropdown>
      </div>
      <div className="tv-header-right" ref={headerRight}>
        <div className="tv-header-cluster">
          <span className={`feed-chip ${feedTone}`} role="status" title={`${marketLabel} · ${active.timeframe} · ${observed}${feed?.gaps ? ` · ${feed.gaps} data gaps` : ''}`}><span className="feed-dot" aria-hidden="true" />{feed?.kind ?? 'Connecting'}</span>
          <ExecutionStatus compact onOpenExecution={onOpenExecution} />
          <span className="tv-sep" aria-hidden="true" />
          <Dropdown className="workspace-menu" buttonClassName="tv-toolbar-button workspace-button" align="right" title="Workspace layout" label={<><Icon name={unsaved ? 'cloudAlert' : 'cloud'} className={unsaved ? 'warning' : 'muted'} /><span className="workspace-name">{saved?.workspace.name ?? (loading ? 'Loading…' : 'Workspace')}</span><Icon name="chevronDown" size={14} /></>}>{(close) => <div className="workspace-menu-content">
            <div className="tv-menu-heading"><strong>{saved?.workspace.name ?? 'Workspace'}</strong><span className={unsaved ? 'warning' : 'positive'} role="status">{loading ? 'Loading…' : saved?.status ?? 'Unavailable'}</span></div>
            <MenuItem icon={<Icon name="cloud" />} disabled={busy || !storage || invalid || conflict} onSelect={() => void workspaceCommand('flush')}>Save layout now</MenuItem>
            <div className="tv-menu-section">
              <label htmlFor="workspace-name">New, copy or rename</label>
              <input id="workspace-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="Workspace name" />
              <div className="compact-actions"><button type="button" disabled={replayLocked || busy || !name.trim() || invalid || conflict} onClick={() => void workspaceCommand('new')}>New</button><button type="button" disabled={replayLocked || busy || !name.trim() || invalid} onClick={() => void workspaceCommand('copy')}>Save as copy</button><button type="button" disabled={replayLocked || busy || !name.trim() || invalid || conflict} onClick={() => void workspaceCommand('rename')}>Rename</button></div>
            </div>
            <div className="tv-menu-separator" />
            <div className="tv-menu-title">Open layout</div>
            <div className="tv-menu-list">{workspaces.map((record) => <MenuItem key={record.id} checked={record.id === saved?.workspace.id} icon={record.id === saved?.workspace.id ? <Icon name="check" /> : null} disabled={replayLocked || busy || loading || !storage} onSelect={() => { close(); if (record.id !== saved?.workspace.id) void changeWorkspace(record.id); }}>{record.name}</MenuItem>)}</div>
            <div className="tv-menu-separator" />
            <label className="tv-menu-check"><input type="checkbox" checked={viewportLinked} disabled={replayLocked} onChange={(event) => { if (!replayLockRef.current) { workspaceRef.current?.sync.set('viewport', event.target.checked); setViewportLinked(event.target.checked); } }} />Sync time range across charts</label>
            <details className="tv-menu-details"><summary>Export chart data…</summary><div className="export-menu-content">
              <label htmlFor="export-from">From · UTC inclusive</label><input id="export-from" type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} />
              <label htmlFor="export-to">To · UTC exclusive</label><input id="export-to" type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} />
              <button type="button" onClick={() => void exportCsv()} disabled={busy || !active.market}><Icon name="download" size={16} />Download raw CSV</button><small>Newest 5,000 bars in the selected range.</small>
              <button type="button" onClick={() => { const workspace = workspaceRef.current; if (!workspace?.screenshot()) setError('Chart image is unavailable until the renderer is ready.'); else workspace.downloadScreenshot(); }}><Icon name="download" size={16} />Download chart PNG</button><small>Vela chart raster: drawing layers are included; DOM overlays are best-effort. Outer docks, dialogs and application chrome are not a full-browser screenshot.</small>
            </div></details>
            <div className="tv-menu-separator" />
            <MenuItem icon={<Icon name="trash" />} danger disabled={replayLocked || busy || !storage} onSelect={() => { if (window.confirm(`Delete “${saved?.workspace.name}” and its unsaved draft?`)) { close(); void workspaceCommand('delete'); } }}>Delete layout</MenuItem>
          </div>}</Dropdown>
          <button type="button" className="tv-icon-button" title="Settings" aria-label="Settings" onClick={onOpenSettings}><Icon name="gear" /></button>
          <button type="button" className="tv-icon-button" title={fullscreen ? 'Exit fullscreen' : 'Fullscreen mode'} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen mode'} onClick={toggleFullscreen}><Icon name={fullscreen ? 'exitFullscreen' : 'fullscreen'} /></button>
          <span className="dock-actions"><button type="button" className="tv-icon-button" title="Watchlist, alerts and agent" aria-label="Watchlist, alerts and agent" onClick={() => openDock('right')}><Icon name="watchlist" /></button><button type="button" className="tv-icon-button" title="Pine editor and trading" aria-label="Pine editor and trading" onClick={() => openDock('bottom')}><Icon name="code" /></button></span>
        </div>
      </div>
    </header>
    <div className="terminal-body" style={{ gridTemplateRows: bottomRows }}>
      <section className="chart-region" aria-label="Chart workspace">
        {storage && !invalid ? <ChartWorkspace key={storage.key} client={client} storage={storage} stream={stream} feeds={feeds} onFeed={onFeed} onSessionError={onSessionError} onReady={onReady} onActiveChart={onActiveChart} /> : <div className="chart-unavailable"><h1>{invalid ? 'Saved chart state needs attention' : loading ? 'Opening your workspace…' : 'Workspace unavailable'}</h1><p>{invalid ? 'No fields have been silently discarded. Download the original state before modifying or deleting this workspace.' : error ?? 'Waiting for the PineTerm server.'}</p></div>}
        <div className="toast-stack">
          {(executionPolicy?.enabled || executionNotice) && <div className="terminal-notice error" role="alert"><strong>{executionPolicy?.enabled ? 'Live handoff enabled' : 'Handoff disabled'}</strong><span>{executionPolicy?.enabled ? 'Kill requests cancellation · venue cancellation NOT guaranteed.' : executionNotice}</span></div>}
          {(error || saved?.message || notice || newer) && <div className={`terminal-notice ${error || invalid || conflict ? 'error' : ''}`} role={error || invalid || conflict ? 'alert' : 'status'}>
            <span>{error ?? saved?.message ?? notice ?? 'A newer server revision is available. Reload to view it.'}</span>
            {(conflict || invalid || newer) && <button type="button" disabled={busy} onClick={() => { if (window.confirm('Discard this local draft and reload the server copy?')) void changeWorkspace(saved!.workspace.id, true); }}>Reload server</button>}
            {saved && (saved.message || newer) && <button type="button" onClick={() => { if (storage) downloadBlob(storage.original(), `${saved.workspace.name}-workspace.json`); }}>Download {invalid ? 'original state' : 'draft'}</button>}
            {conflict && <span>Use the layout menu → Save as copy to preserve both versions.</span>}
            {(error || (notice && !saved?.message && !newer)) && <button type="button" className="tv-icon-button" aria-label="Dismiss" title="Dismiss" onClick={() => { setError(null); setNotice(null); }}><Icon name="close" size={14} /></button>}
          </div>}
        </div>
      </section>
      {compact && drawer && <button className="dock-backdrop" aria-label="Close open drawer" onClick={closeDrawer} />}
      <aside className={`right-dock dock ${drawer === 'right' ? 'is-open' : ''} ${panelVisible ? 'has-panel' : ''}`} ref={(element) => { if (drawer === 'right') dockRef.current = element; }} role={compact && drawer === 'right' ? 'dialog' : undefined} aria-modal={compact && drawer === 'right' ? true : undefined} aria-label="Watchlist, alerts and agent tools">
        <div className="right-panel" hidden={!compact && !ui.panelOpen} style={{ width: compact ? undefined : ui.panelWidth }}>
          {!compact && <div className={`panel-resizer ${resizing === 'panel' ? 'is-resizing' : ''}`} role="separator" tabIndex={0} aria-label="Resize right panel" aria-orientation="vertical" aria-valuemin={240} aria-valuemax={560} aria-valuenow={Math.round(ui.panelWidth)} onPointerDown={(event) => startResize('panel', event)} onKeyDown={panelResizeKeyboard} />}
          <div className="dock-tabs drawer-tabs" role="tablist" aria-label="Right panel">{RIGHT_TABS.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={ui.rightTab === tab.id} onClick={() => updateUi({ rightTab: tab.id })}>{tab.label}</button>)}<button type="button" className="dock-close tv-icon-button" aria-label="Close panel" onClick={closeDrawer}><Icon name="close" /></button></div>
          <div className="dock-content" role="tabpanel">
            {ui.rightTab === 'watchlists' && <Watchlists client={client} stream={stream} activeMarket={active.market} onSelectMarket={selectMarket} onSessionError={onSessionError} selectedId={ui.watchlistId} onSelectList={onSelectList} version={watchlistVersion} />}
            {ui.rightTab === 'alerts' && <AlertPanel client={client} market={active.market} timeframe={active.timeframe} replayActive={replayLocked} createRequested={alertRequested} onCreateHandled={onAlertHandled} onOpenNotifications={onOpenNotifications} onOpenExecution={onOpenExecution} onOpenIntent={(id) => { setSelectedIntentId(id); openBottom('trading'); }} onSessionError={onSessionError} />}
            <div hidden={ui.rightTab !== 'agent'}><AgentPanel client={client} active={active} script={agentScript} paperAccountId={agentPaperAccountId} replay={replaySession} replayLocked={replayLocked} replayReady={replayReady} configVersion={agentConfigVersion} onOpenSettings={onOpenAgent} onSessionError={onSessionError} onApplied={(value) => { setAppliedAgentDraft(value); openBottom('editor'); }} /></div>
          </div>
        </div>
        <nav className="right-strip" aria-label="Widget bar">
          {RIGHT_TABS.map((tab) => <button key={tab.id} type="button" className="strip-button" aria-pressed={ui.panelOpen && ui.rightTab === tab.id} title={tab.label} aria-label={tab.label} onClick={() => toggleRightTab(tab.id)}><Icon name={tab.icon} size={20} /></button>)}
          <span className="strip-spacer" />
          <button type="button" className="strip-button" title="About PineTerm" aria-label="About PineTerm" onClick={onOpenAbout}><Icon name="help" size={20} /></button>
        </nav>
      </aside>
      <section className={`bottom-dock dock ${drawer === 'bottom' ? 'is-open' : ''} ${ui.bottomCollapsed && !compact ? 'is-collapsed' : ''}`} ref={(element) => { if (drawer === 'bottom') dockRef.current = element; }} role={compact && drawer === 'bottom' ? 'dialog' : undefined} aria-modal={compact && drawer === 'bottom' ? true : undefined} aria-label="Pine editor, strategy tester and trading">
        {!ui.bottomCollapsed && !bottomMaximized && <div className={`bottom-resizer ${resizing === 'bottom' ? 'is-resizing' : ''}`} role="separator" tabIndex={0} aria-label="Resize bottom panel" aria-orientation="horizontal" aria-valuemin={120} aria-valuemax={640} aria-valuenow={Math.round(ui.bottomHeight)} onPointerDown={(event) => startResize('bottom', event)} onKeyDown={bottomResizeKeyboard} />}
        <div className="dock-tabs" role="tablist" aria-label="Bottom panel">
          {(['editor', 'tester', 'trading'] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={ui.bottomTab === tab && !(ui.bottomCollapsed && !compact)} onClick={() => selectBottomTab(tab)}>{BOTTOM_LABELS[tab]}</button>)}
          <span className="dock-context" title={feed?.message}><span className={`feed-dot ${feedTone}`} aria-hidden="true" />{marketLabel} · {active.timeframe} · {observed}{feed?.gaps ? ` · ${feed.gaps} data gaps` : ''}</span>
          <span className="dock-window-actions">
            <button type="button" className="tv-icon-button" title={ui.bottomCollapsed ? 'Open panel' : 'Collapse panel'} aria-label={ui.bottomCollapsed ? 'Open panel' : 'Collapse panel'} onClick={() => { updateUi({ bottomCollapsed: !ui.bottomCollapsed }); setBottomMaximized(false); }}><Icon name={ui.bottomCollapsed ? 'chevronUp' : 'chevronDown'} /></button>
            <button type="button" className="tv-icon-button" title={bottomMaximized ? 'Restore panel' : 'Maximize panel'} aria-label={bottomMaximized ? 'Restore panel' : 'Maximize panel'} onClick={() => { if (ui.bottomCollapsed) updateUi({ bottomCollapsed: false }); setBottomMaximized((value) => !value); }}><Icon name={bottomMaximized ? 'restore' : 'maximize'} /></button>
          </span>
          <button type="button" className="dock-close tv-icon-button" aria-label="Close panel" onClick={closeDrawer}><Icon name="close" /></button>
        </div>
        <div className="dock-content" role="tabpanel" hidden={ui.bottomCollapsed && !compact}>
          <ScriptsDock client={client} workspace={pineWorkspace} active={active} replayLocked={replayLocked} tab={ui.bottomTab} onTab={(bottomTab) => updateUi({ bottomTab, bottomCollapsed: false })} onSessionError={onSessionError} onAgentContext={setAgentScript} appliedAgentDraft={appliedAgentDraft} />
          <div className="trading-tab" hidden={ui.bottomTab !== 'trading'}><div inert={replayLocked && !replaySession}><TradingPanel client={client} active={active} replay={replaySession} replayReady={replayReady} onSessionError={onSessionError} onSelectedAccount={setAgentPaperAccountId} /></div><ExternalTradingPanel liveMarket={active.market} replayLocked={replayLocked} selectedIntentId={selectedIntentId} onOpenExecution={onOpenExecution} /></div>
        </div>
      </section>
    </div>
    <ReplayControls client={client} workspace={pineWorkspace} bridge={replayBridge} session={replaySession} container={replayStrip} open={replayOpen} onClose={() => setReplayOpen(false)} onSession={setReplaySession} onLock={onReplayLock} onTradingReady={setReplayReady} onSessionError={onSessionError} />
    <nav className="mobile-navigation" aria-label="Terminal views"><button type="button" onClick={() => setDrawer(null)} aria-pressed={!drawer}><Icon name="chart" />Chart</button><button type="button" onClick={() => openDock('right', 'watchlists')} aria-pressed={drawer === 'right' && ui.rightTab === 'watchlists'}><Icon name="watchlist" />Watchlist</button><button type="button" onClick={() => openDock('bottom', 'editor')} aria-pressed={drawer === 'bottom' && ui.bottomTab === 'editor'}><Icon name="code" />Editor</button><button type="button" onClick={() => openDock('bottom', 'trading')} aria-pressed={drawer === 'bottom' && ui.bottomTab === 'trading'}><Icon name="chart" />Trading</button><button type="button" onClick={() => openDock('right', 'agent')} aria-pressed={drawer === 'right' && ui.rightTab === 'agent'}><Icon name="agent" />Agent</button></nav>
    {settingsOpen && <DataSettings client={client} onClose={onCloseSettings} onOpenSecurity={onOpenSecurity} onOpenNotifications={onOpenNotifications} onOpenExecution={onOpenExecution} onOpenAgent={onOpenAgent} onSessionError={onSessionError} onDatasetImported={(market, timeframe) => {
      const workspace = workspaceRef.current;
      const provider = workspace?.chart.data.providerInstance('csv');
      if (provider instanceof PineTermProvider) workspace!.chart.data.registerProvider('csv', provider);
      selectMarket(market, timeframe);
    }} />}
  </div>;
}
