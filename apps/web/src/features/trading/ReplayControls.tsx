import { useEffect, useRef, useState } from 'react';
import { barClose, type VelaWorkspace } from '@luxalgo/vela/workspace';
import type { Bar, BarPage, Instrument, ReplayMarket, ReplayRequest, ReplaySession } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import { parseMarket, qualifiedMarket } from '../workspace/PineTermProvider.js';
import type { WorkspaceReplayBridge } from './WorkspaceReplayBridge.js';
import { bucketStart, nextBucket } from '../../../../../packages/domain/src/market.js';
import './trading.css';

interface LoadedCell { id: string; market: ReplayMarket['market']; timeframe: string; bars: Bar[] }
const dateInput = (time: number): string => new Date(time).toISOString().slice(0, 16);

export function ReplayControls({ client, workspace, bridge, session, onSession, onLock, onTradingReady, onSessionError }: {
  client: ApiClient; workspace: VelaWorkspace | null; bridge: WorkspaceReplayBridge | null; session: ReplaySession | null;
  onSession: (session: ReplaySession | null) => void; onLock: (locked: boolean) => void; onTradingReady: (ready: boolean) => void; onSessionError: (error: ApiError) => void;
}) {
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [currency, setCurrency] = useState(''); const [cash, setCash] = useState('10000'); const [fees, setFees] = useState('10'); const [slip, setSlip] = useState('0');
  const [speed, setSpeed] = useState('1'); const [playing, setPlaying] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef(session); sessionRef.current = session;
  const loaded = useRef<LoadedCell[]>([]); const timer = useRef<number | undefined>(undefined); const inFlight = useRef(false); const mounted = useRef(true);
  const playRef = useRef(false); const speedRef = useRef(speed); speedRef.current = speed;
  const lastRequest = useRef<ReplayRequest | null>(null);
  const callbacks = useRef({ onSession, onLock, onTradingReady, onSessionError }); callbacks.current = { onSession, onLock, onTradingReady, onSessionError };

  function pause() { playRef.current = false; setPlaying(false); window.clearTimeout(timer.current); workspace?.replay.pause(); }
  function fail(failure: unknown) {
    pause(); callbacks.current.onTradingReady(false); setError(errorMessage(failure));
    if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) callbacks.current.onSessionError(failure);
  }
  function useBounds() {
    if (!workspace || sessionRef.current) return;
    const cells = workspace.cells();
    const bounds = cells.map(cell => ({ bounds: cell.chart.replay.bounds, timeframe: cell.chart.market.timeframe ?? '60' }));
    if (bounds.some(item => !item.bounds)) { setError('Wait for every chart to load actual replayable history.'); return; }
    let start = Math.max(...bounds.map(item => item.bounds!.first));
    let end = Math.min(...bounds.map(item => barClose(item.bounds!.last, item.timeframe)));
    // This explicit preset chooses common loaded boundaries; submitted picker values are never silently rounded.
    for (let pass = 0; pass < 8; pass++) for (const item of bounds) {
      const open = bucketStart(start, item.timeframe);
      if (open !== start) start = nextBucket(open, item.timeframe);
      end = bucketStart(end, item.timeframe);
    }
    if (start >= end) { setError('Loaded chart histories have no common complete interval. Load an overlapping window first.'); return; }
    setFrom(dateInput(start)); setTo(dateInput(end)); setError(null);
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; playRef.current = false; window.clearTimeout(timer.current);
      const current = sessionRef.current;
      if (current) void client.request(`/replay-sessions/${current.id}/stop`, { method: 'POST', csrf: true }).catch(() => {});
    };
  }, [client]);
  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    void workspace.chart.ready().then(async () => {
      if (!alive || sessionRef.current) return;
      const market = parseMarket(workspace.chart.market.symbol);
      if (market) {
        const { markets } = await client.request<{ markets: Instrument[] }>(`/markets?${new URLSearchParams({ provider: market.provider, q: market.symbol })}`);
        if (alive) setCurrency(markets.find(item => item.market.symbol === market.symbol)?.quoteCurrency ?? '');
      }
    }).catch(fail);
    return () => { alive = false; };
  }, [client, workspace]);

  async function verify(current: ReplaySession) {
    for (const cell of loaded.current) {
      const query = new URLSearchParams({ provider: cell.market.provider, symbol: cell.market.symbol, timeframe: cell.timeframe, from: String(current.from), to: String(current.to), limit: '5000', replaySessionId: current.id });
      const page = await client.request<BarPage>(`/bars?${query}`);
      const expected = cell.bars.filter(bar => barClose(bar.time, cell.timeframe) <= current.cursor).slice(-5000);
      if (JSON.stringify(page.bars) !== JSON.stringify(expected)) throw new Error('Server frozen replay history differs from chart preload. Replay paused; stop and select the window again.');
      const chart = workspace?.cell(cell.id)?.chart;
      if (!chart) throw new Error('Replay chart grid changed unexpectedly. Stop replay before switching layout.');
      const latest = expected.at(-1);
      if (latest && current.cursor < current.to && chart.replay.state.cursorTime !== latest.time) throw new Error('Chart and acknowledged server cursor do not match. Replay paused; do not place orders until restarted.');
      if (!latest && barClose(current.from, cell.timeframe) <= current.cursor) throw new Error('No completed chart bar matches the acknowledged replay cursor.');
    }
  }

  async function start(rewind = false) {
    if (!workspace || !bridge || inFlight.current) return;
    pause(); inFlight.current = true; setBusy(true); setError(null); callbacks.current.onLock(true); callbacks.current.onTradingReady(false);
    let created: ReplaySession | null = null;
    try {
      if (sessionRef.current) {
        await client.request(`/replay-sessions/${sessionRef.current.id}/stop`, { method: 'POST', csrf: true });
        sessionRef.current = null; callbacks.current.onSession(null); workspace.replay.stop();
      }
      let request: ReplayRequest;
      if (rewind && lastRequest.current) request = lastRequest.current;
      else {
        const markets = workspace.cells().map(cell => {
          const market = parseMarket(cell.chart.market.symbol);
          if (!market) throw new Error('Every replay chart must select an explicit supported venue.');
          return { market, timeframe: cell.chart.market.timeframe ?? '60' };
        });
        const unique = new Map(markets.map(item => [`${qualifiedMarket(item.market)}:${item.timeframe}`, item]));
        request = { markets: [...unique.values()], from: Date.parse(`${from}Z`), to: Date.parse(`${to}Z`), quoteCurrency: currency, initialBalance: cash, commissionBps: fees, slippageBps: slip };
        if (!Number.isSafeInteger(request.from) || !Number.isSafeInteger(request.to) || request.to <= request.from || !currency) throw new Error('Select UTC start/end and the replay account quote currency.');
        loaded.current = [];
        let total = 0;
        for (const cell of workspace.cells()) {
          const market = parseMarket(cell.chart.market.symbol)!; const timeframe = cell.chart.market.timeframe ?? '60';
          const pages: Bar[][] = []; let before = request.to;
          while (before > request.from) {
            const query = new URLSearchParams({ provider: market.provider, symbol: market.symbol, timeframe, from: String(request.from), to: String(before), limit: '5000' });
            const page = await client.request<BarPage>(`/bars?${query}`);
            if (page.providerError || page.status === 'stale') throw new Error(page.providerError?.message ?? 'Stale history cannot initialize replay.');
            const bars = page.bars.filter(bar => barClose(bar.time, timeframe) <= request.to);
            total += bars.length;
            if (total > 50_000) throw new Error('The chart preload exceeds 50,000 bars. Select a shorter window.');
            pages.push(bars);
            if (page.nextBefore === null || page.nextBefore <= request.from) break;
            if (page.nextBefore >= before) throw new Error('History pagination did not advance.');
            before = page.nextBefore;
          }
          const bars = pages.reverse().flat();
          if (!bars.length) throw new Error('Every chart needs complete actual bars in the selected window. Choose an overlapping confirmed range.');
          loaded.current.push({ id: cell.id, market, timeframe, bars });
        }
      }
      const result = await client.request<{ session: ReplaySession }>('/replay-sessions', { method: 'POST', csrf: true, body: request });
      created = result.session;
      if (!mounted.current) { await client.request(`/replay-sessions/${created.id}/stop`, { method: 'POST', csrf: true }); return; }
      lastRequest.current = request;
      sessionRef.current = created; callbacks.current.onSession(created); bridge.bind(created); bridge.resetEngines();
      await bridge.loadTapes(loaded.current);
      const baseCell = loaded.current.filter(cell => cell.timeframe === created!.baseTimeframe)[0];
      if (!baseCell) throw new Error('No chart matches the server base replay clock.');
      await workspace.replay.start({ from: created.from, cell: baseCell.id });
      if (!workspace.replay.state.active) throw new Error('Vela did not enter replay on the loaded window.');
      bridge.resetEngines(); await verify(created); callbacks.current.onTradingReady(true);
    } catch (failure) {
      if (created) {
        try { await client.request(`/replay-sessions/${created.id}/stop`, { method: 'POST', csrf: true }); } catch { /* Original failure remains visible. */ }
      }
      sessionRef.current = null; callbacks.current.onSession(null);
      try { await bridge.reloadLive(); } catch (restoreError) { setError(`Return-to-live failed: ${errorMessage(restoreError)}`); }
      callbacks.current.onLock(false); fail(failure);
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }

  async function step() {
    const current = sessionRef.current;
    if (!current || !workspace || !bridge || inFlight.current || current.cursor >= current.to) { pause(); return; }
    inFlight.current = true; setBusy(true); setError(null); callbacks.current.onTradingReady(false);
    try {
      const { session: acknowledged } = await client.request<{ session: ReplaySession }>(`/replay-sessions/${current.id}/step`, { method: 'POST', csrf: true });
      sessionRef.current = acknowledged; callbacks.current.onSession(acknowledged); bridge.bind(acknowledged);
      if (!workspace.replay.step()) throw new Error('The chart could not advance to the acknowledged server bar. Stop and restart replay.');
      bridge.resetEngines(); await verify(acknowledged); callbacks.current.onTradingReady(acknowledged.cursor < acknowledged.to);
      if (acknowledged.cursor >= acknowledged.to) pause();
    } catch (failure) { fail(failure); }
    finally {
      inFlight.current = false; if (mounted.current) setBusy(false);
      if (playRef.current) timer.current = window.setTimeout(() => void step(), 1000 / Number(speedRef.current));
    }
  }
  async function stop() {
    if (!bridge || inFlight.current) return;
    pause(); inFlight.current = true; setBusy(true); setError(null); callbacks.current.onTradingReady(false);
    try {
      const current = sessionRef.current;
      if (current) await client.request(`/replay-sessions/${current.id}/stop`, { method: 'POST', csrf: true });
      await bridge.reloadLive(); sessionRef.current = null; callbacks.current.onSession(null); callbacks.current.onLock(false);
    } catch (failure) { fail(failure); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <section className="replay-controls" aria-label="Server-authoritative bar replay">
    {!session ? <details><summary>Bar replay</summary><div className="replay-picker">
      <label>Start · UTC<input aria-label="Replay start UTC" type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} disabled={busy} /></label>
      <label>End · UTC exclusive<input aria-label="Replay end UTC" type="datetime-local" value={to} onChange={event => setTo(event.target.value)} disabled={busy} /></label>
      <label>Account quote currency<input aria-label="Replay quote currency" value={currency} maxLength={20} onChange={event => setCurrency(event.target.value.toUpperCase())} disabled={busy} /></label>
      <label>Initial paper cash<input inputMode="decimal" value={cash} onChange={event => setCash(event.target.value)} disabled={busy} /></label>
      <label>Commission · bps<input inputMode="decimal" value={fees} onChange={event => setFees(event.target.value)} disabled={busy} /></label>
      <label>Adverse slippage · bps<input inputMode="decimal" value={slip} onChange={event => setSlip(event.target.value)} disabled={busy} /></label>
      <button type="button" disabled={busy || !workspace} onClick={useBounds}>Use loaded common bounds</button><button type="button" disabled={busy || !workspace || !bridge} onClick={() => void start()}>Start replay</button>
      <small>Only actual confirmed history. Boundaries must align to every chart interval; missing candles reject the full window.</small>
    </div></details> : <div className="replay-active">
      <strong>REPLAY · isolated paper account</strong><time dateTime={new Date(session.cursor).toISOString()}>{new Date(session.cursor).toISOString()}</time>
      <button type="button" disabled={busy || session.cursor >= session.to || !!error} onClick={() => { pause(); void step(); }}>Step one bar</button>
      <button type="button" disabled={!playing && (busy || session.cursor >= session.to || !!error)} onClick={() => { if (playing) pause(); else { playRef.current = true; setPlaying(true); void step(); } }}>{playing ? 'Pause' : 'Play'}</button>
      <select aria-label="Replay bars per second" value={speed} onChange={event => setSpeed(event.target.value)}>{['0.5', '1', '2', '5'].map(value => <option key={value} value={value}>{value} bars/sec</option>)}</select>
      <button type="button" disabled={busy} onClick={() => void start(true)}>Rewind · new account</button><button type="button" disabled={busy} onClick={() => void stop()}>Stop / Return to live</button>
      <small>Replay cannot trade live accounts or send notifications. Independently armed server live alerts continue. {session.cursor >= session.to ? 'Window complete; stop or rewind to a fresh account.' : 'Raw-bar fills; coarse-only datasets acknowledge at bar close and exclude orders accepted mid-bar. No intrabar-path or OCO guarantee.'}</small>
    </div>}
    {busy && <span role="status">{session ? 'Awaiting server / chart acknowledgement…' : 'Loading complete actual replay history…'}</span>}
    {error && <span className="negative" role="alert">{error}</span>}
  </section>;
}
