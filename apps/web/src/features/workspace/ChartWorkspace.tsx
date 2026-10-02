import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { VelaWorkspace } from '@luxalgo/vela/workspace';
import type { PineWorkerEngine } from '@luxalgo/vela-pinets';
import { sharedBarStore, type ChartConfig } from '@luxalgo/vela';
import type { ChartCell } from '@luxalgo/vela/workspace';
import type { MarketRef, ReplaySession, ScriptRecord, ScriptRevision } from '@pineterm/contracts';
import { TIMEFRAMES } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import { BackendMarketStream, PineTermProvider, feedKey, parseMarket } from './PineTermProvider.js';
import type { FeedState } from './PineTermProvider.js';
import { WorkspaceStorage } from './WorkspaceStorage.js';
import '../scripts/chartPersistence.js';
import { ProviderLockedPineWorkerEngine } from './ProviderLockedPineWorkerEngine.js';
import type { WorkspaceReplayBridge } from '../trading/WorkspaceReplayBridge.js';
import { qualifiedMarket } from './PineTermProvider.js';
import { barClose } from '@luxalgo/vela/workspace';

export interface ActiveChart { cellId: string; market: MarketRef | null; timeframe: string; priceStyle: string }
export interface ChartWorkspaceProps {
  client: ApiClient; storage: WorkspaceStorage; stream: BackendMarketStream; feeds: Record<string, FeedState>;
  onFeed: (state: FeedState) => void; onSessionError: (error: ApiError) => void;
  onReady: (workspace: VelaWorkspace | null, replayBridge: WorkspaceReplayBridge | null) => void; onActiveChart: (chart: ActiveChart) => void;
}

/** Owns Vela's lifecycle; editor/replay modules use the live workspace seam. */
export function ChartWorkspace({ client, storage, stream, feeds, onFeed, onSessionError, onReady, onActiveChart }: ChartWorkspaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const [cells, setCells] = useState<ChartCell[]>([]);
  const [diagnostics, setDiagnostics] = useState<Record<string, string>>({});
  const [mountError, setMountError] = useState<string | null>(null);
  const callbacks = useRef({ onFeed, onSessionError, onReady, onActiveChart });
  callbacks.current = { onFeed, onSessionError, onReady, onActiveChart };

  useEffect(() => {
    if (!host.current) return;
    const workers = new Set<PineWorkerEngine>();
    const pendingWorkers: PineWorkerEngine[] = [];
    const cellWorkers = new Map<string, PineWorkerEngine>();
    const cellListeners = new Map<string, Array<() => void>>();
    const providers = (['binance', 'coinbase', 'csv'] as const).map((id) => new PineTermProvider(id, client, stream, (state) => callbacks.current.onFeed(state), (error) => callbacks.current.onSessionError(error)));
    let workspace: VelaWorkspace;
    try {
      workspace = new VelaWorkspace(host.current, {
        layout: '1', symbol: 'COINBASE:BTC-USD', timeframe: '60', priceStyle: 'candles', bars: 500,
        theme: { background: '#0B1018', textColor: '#E6EDF7', gridColor: '#182233', borderColor: '#253247', upColor: '#2DD4BF', downColor: '#FB7185', fontFamily: 'system-ui, sans-serif' },
        upColor: '#2DD4BF', downColor: '#FB7185', animations: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        sync: { crosshair: true }, timeframes: [...TIMEFRAMES], timezone: 'Etc/UTC', live: true,
        persist: storage.key, storage,
        providers: Object.fromEntries(providers.map((provider) => [provider.provider, () => provider])),
        engines: { pine: () => { const engine = new ProviderLockedPineWorkerEngine(providers); workers.add(engine); pendingWorkers.push(engine); return engine; } },
        indicators: async () => {
          const { scripts } = await client.request<{ scripts: ScriptRecord[] }>('/scripts');
          return Promise.all(scripts.map(async (script) => {
            const { revision } = await client.request<{ revision: ScriptRevision }>(`/scripts/${script.id}`);
            return { name: script.name, script: revision.source, language: 'pine', enabled: false, category: 'PineTerm editable library' };
          }));
        },
        // Keep Vela's chart chrome, object tree, drawing tools, undo/redo and settings.
        topbar: { left: ['symbol', 'timeframes', 'style', 'layout', 'indicators', 'undo-redo'], right: ['panels', 'screenshot'] },
      });
    } catch (error) {
      setMountError(errorMessage(error));
      for (const worker of workers) worker.terminate();
      for (const provider of providers) provider.dispose();
      return;
    }
    const mobile = window.matchMedia('(max-width: 600px)');
    let replaySession: ReplaySession | null = null;
    const updateActive = () => {
      const active = workspace.active;
      const market = active.chart.market;
      const config = active.chart.renderer.getConfig() as ChartConfig | null;
      callbacks.current.onActiveChart({ cellId: active.id, market: parseMarket(market.symbol), timeframe: market.timeframe ?? '60', priceStyle: config?.series.style ?? 'candles' });
      if (mobile.matches && workspace.maximizedCell !== active.id) workspace.maximizeCell(active.id);
    };
    const capture = () => storage.set(storage.key, JSON.stringify(workspace.getState()));
    const saveIndicatorChanges = () => queueMicrotask(capture);
    const bindCell = (id: string) => {
      const cell = workspace.cell(id);
      if (!cell) return;
      const engine = pendingWorkers.shift();
      if (engine) cellWorkers.set(id, engine);
      const listeners = [
        cell.chart.on('market:changed', updateActive),
        cell.chart.on('load:start', ({ symbol, timeframe }) => {
          const market = parseMarket(symbol);
          if (market) callbacks.current.onFeed({ market, timeframe, kind: 'loading', message: 'Loading authoritative candles…', asOf: null, gaps: 0 });
          setDiagnostics((current) => { const next = { ...current }; delete next[id]; return next; });
          updateActive();
        }),
        cell.chart.on('load:end', ({ symbol, timeframe, bars }) => {
          if (!replaySession) return;
          const market = parseMarket(symbol);
          if (market) callbacks.current.onFeed({ market, timeframe, kind: bars ? 'historical' : 'empty', message: 'Frozen replay history · completed bars only', asOf: replaySession.cursor, gaps: 0 });
        }),
        cell.chart.on('indicator:error', ({ error }) => setDiagnostics((current) => ({ ...current, [id]: `Pine preview error: ${error.message}` }))),
        cell.chart.on('indicator:inputs', saveIndicatorChanges),
        cell.chart.on('indicator:visibility', saveIndicatorChanges),
        cell.chart.on('indicator:moved', saveIndicatorChanges),
        cell.chart.on('indicator:removed', saveIndicatorChanges),
        cell.chart.on('data:unresolved', ({ symbol }) => {
          const market = parseMarket(symbol);
          if (market) callbacks.current.onFeed({ market, timeframe: cell.chart.market.timeframe ?? '60', kind: 'unavailable', message: 'No registered backend provider can serve this instrument.', asOf: null, gaps: 0 });
        }),
      ];
      cellListeners.set(id, listeners);
      setCells(workspace.cells());
    };
    for (const cell of workspace.cells()) bindCell(cell.id);
    const unbind = [
      workspace.on('cell:created', ({ id }) => bindCell(id)),
      workspace.on('cell:destroyed', ({ id }) => {
        for (const stop of cellListeners.get(id) ?? []) stop(); cellListeners.delete(id);
        const engine = cellWorkers.get(id); if (engine) { engine.terminate(); workers.delete(engine); cellWorkers.delete(id); }
        setCells(workspace.cells());
      }),
      workspace.on('cell:active', updateActive),
      workspace.on('layout:changed', () => { setCells(workspace.cells()); updateActive(); }),
      workspace.on('cell:maximized', ({ id }) => {
        if (mobile.matches && id === null) workspace.maximizeCell(workspace.active.id);
      }),
      workspace.on('state:changed', () => { storage.set(storage.key, JSON.stringify(workspace.getState())); updateActive(); }),
    ];
    const resizeMobile = () => { workspace.maximizeCell(mobile.matches ? workspace.active.id : null); };
    mobile.addEventListener('change', resizeMobile);
    const protectChrome = () => {
      for (const element of workspace.root.querySelectorAll<HTMLElement>('.vela-widget-topbar, .vela-mobilebar, .vela-widget-bottombar, .vela-lp-layer')) {
        element.inert = replaySession !== null;
        element.classList.toggle('replay-native-disabled', replaySession !== null);
      }
      for (const cell of workspace.cells()) {
        const state = cell.chart.replay.state;
        const hidden = !!replaySession && replaySession.cursor < replaySession.to && (!state.active || state.cursorTime === null || barClose(state.cursorTime, cell.chart.market.timeframe) > replaySession.cursor);
        cell.host.classList.toggle('replay-awaiting-close', hidden);
      }
    };
    const keyboardGuard = (event: globalThis.KeyboardEvent) => {
      if (!replaySession) return;
      // Native market/layout shortcuts share the chart root. Drawing tools remain pointer-accessible.
      event.stopImmediatePropagation();
      if (event.key !== 'Escape') event.preventDefault();
    };
    workspace.root.addEventListener('keydown', keyboardGuard, true);
    const chromeObserver = new MutationObserver(protectChrome);
    chromeObserver.observe(workspace.root, { childList: true, subtree: true });
    const bridge: WorkspaceReplayBridge = {
      bind(session) {
        if (session && !replaySession) workspace.root.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        replaySession = session;
        stream.setReplay(session ? { sessionId: session.id, cursor: session.cursor } : null);
        for (const provider of providers) { provider.resetPending(); if (!session) provider.setReplayTapes([]); }
        protectChrome();
      },
      async loadTapes(tapes) {
        for (const provider of providers) provider.setReplayTapes(tapes);
        await Promise.all(tapes.map(async tape => {
          const cell = workspace.cell(tape.id);
          if (!cell) throw new Error('Replay grid changed before history loaded.');
          // An empty data override forces a public in-place reload; the feed still resolves the registered provider (no offline synthetic ticks).
          await cell.chart.setMarket({ data: [], symbol: qualifiedMarket(tape.market), timeframe: tape.timeframe, bars: tape.bars.length, visibleRange: { from: tape.bars[0]!.time, to: barClose(tape.bars.at(-1)!.time, tape.timeframe) } });
          await cell.chart.historyComplete();
        }));
      },
      resetEngines() {
        sharedBarStore.clear();
        for (const cell of workspace.cells()) {
          const snapshots = cell.chart.indicators().filter(handle => handle.source).map(handle => ({
            id: handle.id, source: handle.source!, title: handle.title, inputs: handle.inputValues(), props: handle.propValues(), visible: handle.visible,
            pane: cell.chart.panes.list().find(pane => pane.indicators.some(indicator => indicator.id === handle.id)),
          }));
          for (const handle of cell.chart.indicators()) if (handle.source) handle.remove();
          const previous = cellWorkers.get(cell.id);
          if (previous) { previous.terminate(); workers.delete(previous); }
          const engine = new ProviderLockedPineWorkerEngine(providers);
          workers.add(engine); cellWorkers.set(cell.id, engine); cell.chart.registerEngine('pine', engine);
          for (const snapshot of snapshots) {
            const handle = cell.chart.addIndicator(snapshot.source, { id: snapshot.id, title: snapshot.title, inputs: snapshot.inputs, props: snapshot.props, overlay: snapshot.pane?.kind === 'price' });
            if (!snapshot.visible) handle.setVisible(false);
            if (snapshot.pane && snapshot.pane.kind !== 'price') {
              const paneId = snapshot.pane.id;
              handle.on('ready', () => { if (cell.chart.panes.list().some(pane => pane.id === paneId)) handle.moveTo({ pane: paneId }); });
            }
          }
          if (replaySession) cell.chart.setVisibleRangePreset('ALL');
        }
        protectChrome();
      },
      async reloadLive() {
        bridge.bind(null); bridge.resetEngines();
        workspace.replay.stop();
        await Promise.all(workspace.cells().map(async cell => {
          const market = parseMarket(cell.chart.market.symbol);
          if (market) await cell.chart.setMarket({ data: [], symbol: qualifiedMarket(market), timeframe: cell.chart.market.timeframe ?? '60', bars: 500 });
          await cell.chart.historyComplete();
        }));
      },
    };
    callbacks.current.onReady(workspace, bridge); resizeMobile(); updateActive();
    workspace.root.addEventListener('pineterm:pine-state', capture);
    window.addEventListener('pagehide', capture);
    return () => {
      capture();
      chromeObserver.disconnect(); workspace.root.removeEventListener('keydown', keyboardGuard, true);
      workspace.root.removeEventListener('pineterm:pine-state', capture);
      window.removeEventListener('pagehide', capture); mobile.removeEventListener('change', resizeMobile);
      for (const stop of unbind) stop(); for (const listeners of cellListeners.values()) for (const stop of listeners) stop();
      workspace.destroy(); for (const worker of workers) worker.terminate(); for (const provider of providers) provider.dispose();
      callbacks.current.onReady(null, null);
    };
  }, [client, storage, stream]);

  return <div className="chart-surface">
    <div className="vela-host" ref={host} aria-label="Interactive financial charts" />
    {mountError && <div className="chart-state error" role="alert"><strong>Chart could not start</strong><p>{mountError}</p></div>}
    {cells.map((cell) => {
      const market = parseMarket(cell.chart.market.symbol);
      const feed = market ? feeds[feedKey(market, cell.chart.market.timeframe ?? '60')] : undefined;
      const show = feed && ['loading', 'empty', 'unavailable', 'disconnected', 'stale'].includes(feed.kind);
      const diagnostic = diagnostics[cell.id];
      if (!show && !diagnostic) return null;
      return createPortal(<div className={`cell-notice ${feed?.kind === 'unavailable' || diagnostic ? 'error' : ''}`} role={diagnostic || feed?.kind === 'unavailable' ? 'alert' : 'status'}>
        <strong>{diagnostic ? 'Pine diagnostic' : feed?.kind === 'empty' ? 'No history' : feed?.kind === 'unavailable' ? 'Provider unavailable' : feed?.kind === 'disconnected' ? 'Feed disconnected' : feed?.kind === 'stale' ? 'Cached data · stale' : 'Loading chart'}</strong>
        <span>{diagnostic ?? feed?.message}</span>
        {diagnostic && <button type="button" onClick={() => setDiagnostics((current) => { const next = { ...current }; delete next[cell.id]; return next; })}>Dismiss diagnostic</button>}
      </div>, cell.host, cell.id);
    })}
  </div>;
}
