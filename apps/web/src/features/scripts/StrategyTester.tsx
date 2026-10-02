import { useEffect, useRef, useState } from 'react';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import type { BacktestJob, BarPage, EquityPoint, Instrument, PineValue, ScriptRevision } from '@pineterm/contracts';
import { PINE_TS_PROVIDER_POLICY } from '@pineterm/contracts';
import { nextBucket } from '../../../../../packages/domain/src/market.js';
import { ApiClient, errorMessage } from '../../api.js';
import type { ActiveChart } from '../workspace/ChartWorkspace.js';

export const PINE_LIMITATIONS = `PineTS simulation, not TradingView-identical execution: OCA sibling cancellation/reduction is not enforced, liquidation is approximate, numerical results may differ, and FX conversion is not supplied. Imported lookahead can repaint; no no-repaint guarantee. Browser previews are not durable alert or execution authority. ${PINE_TS_PROVIDER_POLICY}`;

function Curve({ points, field, currency }: { points: EquityPoint[]; field: 'equity' | 'drawdown'; currency: string }) {
  const values = points.map((point) => point[field] === null ? null : Number(point[field])).map((value) => value !== null && Number.isFinite(value) ? value : null);
  const finite = values.filter((value): value is number => value !== null);
  if (!finite.length) return <p>No {field} observations are available.</p>;
  const low = Math.min(...finite); const high = Math.max(...finite); const span = high - low || Math.max(Math.abs(high) * 0.01, 1);
  const first = points[0]!.time; const last = points.at(-1)!.time; const timeSpan = last - first || 1;
  let path = ''; let open = false;
  values.forEach((value, index) => {
    if (value === null) { open = false; return; }
    const x = 45 + (points[index]!.time - first) / timeSpan * 700;
    const y = 116 - (value - low) / span * 90;
    path += `${open ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `; open = true;
  });
  return <figure className="strategy-curve"><figcaption>{field === 'equity' ? 'Equity' : 'Drawdown'} · {currency}</figcaption><svg role="img" aria-label={`${field} curve in ${currency}, ${points.length} bar-aligned observations`} viewBox="0 0 790 155"><path d="M45,15V116H745" fill="none" stroke="#253247" /><path d={path} fill="none" stroke={field === 'equity' ? '#2DD4BF' : '#FB7185'} strokeWidth="2" /><text x="2" y="24">{high.toPrecision(6)}</text><text x="2" y="116">{low.toPrecision(6)}</text><text x="45" y="144">{new Date(first).toISOString().slice(0, 16)}</text><text x="745" y="144" textAnchor="end">{new Date(last).toISOString().slice(0, 16)} UTC</text></svg></figure>;
}

export function StrategyTester({ client, revision, sourceSaved, inputs, props, active, instrument, workspace, version, onError }: { client: ApiClient; revision: ScriptRevision | null; sourceSaved: boolean; inputs: Record<string, PineValue>; props: Record<string, PineValue>; active: ActiveChart; instrument: Instrument | null; workspace: VelaWorkspace | null; version: number; onError: (failure: unknown) => void }) {
  const [jobs, setJobs] = useState<BacktestJob[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<BacktestJob | null>(null);
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [bounds, setBounds] = useState<string | null>(null);
  const fail = useRef(onError); fail.current = onError;
  const selection = `${active.cellId}:${active.market?.provider}:${active.market?.symbol}:${active.timeframe}`;
  const selectionRef = useRef(selection); selectionRef.current = selection;
  useEffect(() => {
    const controller = new AbortController();
    void client.request<{ jobs: BacktestJob[] }>('/backtests', { signal: controller.signal }).then(({ jobs: rows }) => { setJobs(rows); setJobId((id) => id ?? rows[0]?.id ?? null); }).catch((failure: unknown) => { if (!controller.signal.aborted) { setError(errorMessage(failure)); fail.current(failure); } });
    return () => controller.abort();
  }, [client, version]);
  useEffect(() => {
    if (!jobId) { setJob(null); return; }
    const controller = new AbortController(); let timer: number | undefined;
    setJob(null);
    const refresh = async () => {
      try {
        const { job: value } = await client.request<{ job: BacktestJob }>(`/backtests/${jobId}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setJob(value); setJobs((rows) => [value, ...rows.filter((row) => row.id !== value.id)]);
        if (value.state === 'queued' || value.state === 'running') timer = window.setTimeout(() => void refresh(), 750);
      } catch (failure) { if (!controller.signal.aborted) { setError(errorMessage(failure)); fail.current(failure); } }
    };
    void refresh(); return () => { controller.abort(); window.clearTimeout(timer); };
  }, [client, jobId, version]);
  useEffect(() => { setFrom(''); setTo(''); setBounds(null); }, [active.market?.provider, active.market?.symbol, active.timeframe]);
  useEffect(() => {
    const chart = workspace?.cell(active.cellId)?.chart;
    if (!chart || !job?.result || job.request.market.provider !== active.market?.provider || job.request.market.symbol !== active.market?.symbol || job.request.timeframe !== active.timeframe) return;
    const ids: string[] = [];
    chart.marks.defineGroup({ id: 'pineterm-backtest', label: 'PineTerm backtest fills', visible: true });
    for (const trade of job.result.trades) {
      const entryId = `pineterm-backtest:${job.id}:${trade.id}:entry`; ids.push(entryId);
      chart.marks.add({ id: entryId, group: 'pineterm-backtest', time: trade.entryTime, title: `${trade.side} entry · simulation`, tooltip: `${trade.entryId}: ${trade.quantity} @ ${trade.entryPrice}`, glyph: { color: '#2DD4BF', letter: 'E' }, content: { text: `PineTS backtest ${job.id}\n${trade.entryId}: ${trade.quantity} @ ${trade.entryPrice}\n${new Date(trade.entryTime).toISOString()}` } });
      if (trade.exitTime !== null) {
        const exitId = `pineterm-backtest:${job.id}:${trade.id}:exit`; ids.push(exitId);
        chart.marks.add({ id: exitId, group: 'pineterm-backtest', time: trade.exitTime, title: `${trade.side} exit · simulation`, tooltip: `${trade.exitId ?? 'Exit'} @ ${trade.exitPrice}`, glyph: { color: '#FB7185', letter: 'X' }, content: { text: `Exit @ ${trade.exitPrice}\nP/L ${trade.profit ?? 'undefined'} · fees ${trade.commission ?? 'undefined'}\n${new Date(trade.exitTime).toISOString()}` } });
      }
    }
    return () => { for (const id of ids) chart.marks.remove(id); };
  }, [job, workspace, active.cellId, active.market?.provider, active.market?.symbol, active.timeframe]);

  async function historyPreset() {
    if (!active.market) return;
    setBusy(true); setError(null);
    try {
      const params = new URLSearchParams({ provider: active.market.provider, symbol: active.market.symbol, timeframe: active.timeframe, limit: '5000' });
      const page = await client.request<BarPage>(`/bars?${params}`);
      if (selectionRef.current !== selection) throw new Error('The market or interval changed while loading history. Select the intended range again.');
      if (page.providerError) throw new Error(`Provider unavailable: ${page.providerError.message}`);
      const closed = page.bars.filter((bar) => nextBucket(bar.time, active.timeframe) <= page.asOf);
      if (!closed.length) throw new Error('No closed history is available. Import a dataset or explicitly select another range/provider.');
      const start = closed[0]!.time; const end = nextBucket(closed.at(-1)!.time, active.timeframe);
      setFrom(new Date(start).toISOString().slice(0, 19)); setTo(new Date(end).toISOString().slice(0, 19));
      setBounds(`${closed.length} observed closed bars: ${new Date(start).toISOString()} → ${new Date(end).toISOString()}. ${page.nextBefore !== null ? 'Earlier history exists; this preset uses only this named newest page.' : 'No earlier rows on this page.'} Server independently verifies authoritative confirmation, every requested bucket, and gaps before execution.`);
    } catch (failure) { setError(errorMessage(failure)); onError(failure); } finally { setBusy(false); }
  }
  async function run() {
    if (!revision || !sourceSaved || !active.market) return;
    setError(null); setBusy(true);
    try {
      const start = Date.parse(`${from}Z`); const end = Date.parse(`${to}Z`);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) throw new Error('Choose a non-empty UTC half-open range: from must precede to.');
      const { jobId: id } = await client.request<{ jobId: string }>('/backtests', { method: 'POST', csrf: true, body: { scriptRevisionId: revision.id, market: active.market, timeframe: active.timeframe, from: start, to: end, inputs, props } });
      setJobId(id);
    } catch (failure) { setError(errorMessage(failure)); onError(failure); } finally { setBusy(false); }
  }
  async function cancel() {
    if (!job) return;
    setBusy(true);
    try { const value = await client.request<{ job: BacktestJob }>(`/backtests/${job.id}/cancel`, { method: 'POST', csrf: true }); setJob(value.job); }
    catch (failure) { setError(errorMessage(failure)); onError(failure); } finally { setBusy(false); }
  }
  async function exportTrades() {
    if (!job) return;
    try {
      const blob = await client.request<Blob>(`/backtests/${job.id}/trades.csv`, { responseType: 'blob' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `pineterm-${job.id}-trades.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { setError(errorMessage(failure)); onError(failure); }
  }
  const result = job?.result; const summary = result?.strategy;
  return <section className="strategy-tester" aria-label="Isolated PineTS strategy tester">
    <div className="pine-toolbar"><strong>Strategy Tester</strong><span>{active.market?.provider.toUpperCase()}:{active.market?.symbol} · {active.timeframe} · raw confirmed bars</span><label>Jobs<select aria-label="Backtest jobs" value={jobId ?? ''} onChange={(event) => setJobId(event.target.value || null)}><option value="">No selection</option>{jobId && !jobs.some((row) => row.id === jobId) && <option value={jobId}>{jobId.slice(0, 8)} · submitted</option>}{jobs.map((row) => <option key={row.id} value={row.id}>{new Date(row.createdAt).toISOString()} · {row.state} · {row.id.slice(0, 8)}</option>)}</select></label></div>
    <div className="strategy-range">
      <label>From · UTC inclusive<input aria-label="Backtest from UTC" type="datetime-local" step="1" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>To · UTC exclusive<input aria-label="Backtest to UTC" type="datetime-local" step="1" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <button type="button" onClick={() => void historyPreset()} disabled={busy || !active.market}>Use available history page</button>
      <button type="button" className="primary" onClick={() => void run()} disabled={busy || !revision || !sourceSaved || !active.market || !from || !to}>Run backtest</button>
      <span>Saved revision {revision ? `${revision.revision} · ${revision.id.slice(0, 8)}` : 'required: save source in Editor first'}</span>
      {!sourceSaved && <span className="pine-diagnostic">Unsaved source is not executed. Return to Editor and Save first. Input/property overrides remain explicit in the submitted job.</span>}
    </div>
    <p className="muted">Quote currency {instrument?.quoteCurrency ?? 'metadata unavailable'} must match the strategy’s currency exactly. USD is not USDT. Unsupported FX conversion is rejected; existing/imported source is never rewritten.</p>
    {bounds && <p className="muted">{bounds}</p>}{error && <p role="alert" className="pine-diagnostic">{error}</p>}
    <p className="pine-limitations">{PINE_LIMITATIONS}</p>
    {!job && <p>{jobId ? 'Loading persisted job…' : 'No backtest results. Choose an immutable saved revision and submit an explicit date range.'}</p>}
    {job && <><div className="pine-toolbar"><strong role="status">Job {job.state}</strong><code>{job.id}</code>{(job.state === 'queued' || job.state === 'running') && <button type="button" onClick={() => void cancel()} disabled={busy}>Cancel backtest</button>}{job.state === 'succeeded' && <button type="button" onClick={() => void exportTrades()}>Export trades CSV</button>}</div>{job.diagnostic && <p className="pine-diagnostic" role="alert">{job.diagnostic.code}: {job.diagnostic.message}</p>}{job.state === 'cancelled' && <p>Cancelled. This job has no completed profit report.</p>}{(job.state === 'queued' || job.state === 'running') && <p>Awaiting the isolated Docker runner. The API remains available; no partial report is shown as complete.</p>}
      {summary && <><dl className="strategy-metrics">{[['Initial equity', summary.initialEquity], ['Final equity', summary.finalEquity], ['Net P/L', summary.netPnl], ['Fees', summary.fees], ['Max drawdown', summary.maxDrawdown], ['Win rate', summary.winRate === null ? null : `${summary.winRate}%`], ['Closed trades', summary.tradeCount], ['Profit factor', summary.profitFactor], ['Position size', summary.positionSize]].map(([title, value]) => <div key={title}><dt>{title}</dt><dd>{value === null ? 'Undefined' : String(value)} {['Initial equity', 'Final equity', 'Net P/L', 'Fees', 'Max drawdown'].includes(String(title)) && summary.currency}</dd></div>)}</dl><div className="strategy-curves"><Curve points={result!.equityCurve} field="equity" currency={summary.currency} /><Curve points={result!.equityCurve} field="drawdown" currency={summary.currency} /></div><div className="strategy-trades"><table><caption>Actual PineTS simulated fills · entry E / exit X timeline markers on matching chart</caption><thead><tr><th>Side / quantity</th><th>Entry · UTC</th><th>Entry price</th><th>Exit · UTC</th><th>Exit price</th><th>P/L · {summary.currency}</th><th>Fees · {summary.currency}</th><th>Status</th></tr></thead><tbody>{result!.trades.map((trade) => <tr key={trade.id}><td>{trade.side} · {trade.quantity}</td><td>{new Date(trade.entryTime).toISOString()}<small>{trade.entryId}</small></td><td>{trade.entryPrice}</td><td>{trade.exitTime === null ? 'Open' : new Date(trade.exitTime).toISOString()}<small>{trade.exitId}</small></td><td>{trade.exitPrice ?? '—'}</td><td>{trade.profit ?? 'Undefined'}</td><td>{trade.commission ?? 'Undefined'}</td><td>{trade.status}</td></tr>)}</tbody></table>{!result!.trades.length && <p>No trades executed in this run.</p>}</div></>}
      {result?.warnings.map((warning, index) => <p className="pine-diagnostic" key={index}>{warning.message}{warning.bar === undefined ? '' : ` · bar ${warning.bar}`}</p>)}
      <details><summary>Immutable provenance / resolved strategy configuration</summary><p>Requested revision: {job.request.scriptRevisionId}. Run market: {job.request.market.provider}:{job.request.market.symbol}, interval {job.request.timeframe}, [{new Date(job.request.from).toISOString()}, {new Date(job.request.to).toISOString()}).</p><pre>{JSON.stringify({ provenance: job.provenance, resolvedConfig: result?.resolvedConfig ?? null, submittedInputs: job.request.inputs, submittedProps: job.request.props }, null, 2)}</pre></details></>}
  </section>;
}
