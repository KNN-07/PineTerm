import { useExecution } from './ExecutionContext.js';

export function ExecutionRisk() {
  const { usage, positions, intents, policy, loading } = useExecution();
  return <section className="execution-risk" aria-label="External reported risk and fill deltas">
    <h3>Submitted-notional risk · separate currencies</h3>
    <p className="muted">These limits reserve requested/submitted notional, not complete exchange portfolio exposure. Unknown outcomes retain pending capacity and notional until the bound external driver reconciles. USD is not USDT; no currency conversion.</p>
    {!usage.length && !loading && <p>No retained execution usage reported.</p>}
    <ul className="execution-cards">{usage.map((row) => {
      const limit = policy?.quoteLimits.find((value) => value.quoteCurrency === row.quoteCurrency);
      return <li key={row.quoteCurrency}><strong>{row.quoteCurrency}</strong><dl className="execution-details"><dt>Rolling-24h retained submitted notional</dt><dd>{row.rolling24hNotional} {row.quoteCurrency}</dd><dt>Unresolved reserved notional</dt><dd>{row.unresolvedNotional} {row.quoteCurrency}</dd><dt>Pending capacity in use</dt><dd>{row.pendingIntents} / {policy?.maxPending ?? 'unconfigured'}</dd><dt>Per-order / rolling-24h limits</dt><dd>{limit ? `${limit.perOrderNotional} / ${limit.rolling24hNotional} ${row.quoteCurrency}` : 'No configured currency budget'}</dd></dl></li>;
    })}</ul>
    {intents.some((intent) => intent.state === 'unknown') && <p className="message error">Unknown outcome: new claims and creation for the affected executor are blocked. The operator must query the venue by the original stable clientOrderId (intent ID); never redispatch or free unknown reservations.</p>}
    <h3>Externally reported fill deltas · NOT exchange balances</h3>
    <p className="muted">Net reported buys minus sells since PineTerm handoff tracking began. These are neither paper holdings/cash nor complete exchange positions, available balances, or portfolio P/L. Only an executor-bound API key can report outcomes.</p>
    {!positions.length && !loading && <p>No external fills reported.</p>}
    <ul className="execution-cards">{positions.map((position) => <li key={`${position.executorId}:${position.market.provider}:${position.market.symbol}`}><strong>{position.market.provider.toUpperCase()}:{position.market.symbol}</strong><small>Executor {position.executorId}</small><dl className="execution-details"><dt>Net fill quantity delta</dt><dd>{position.netQuantity}</dd><dt>Reported bought / sold quantity</dt><dd>{position.boughtQuantity} / {position.soldQuantity}</dd><dt>Reported bought / sold notional</dt><dd>{position.boughtNotional} / {position.soldNotional} {position.quoteCurrency}</dd><dt>Reported fees / rebates by currency</dt><dd>{Object.entries(position.fees).map(([currency, value]) => `${value} ${currency}`).join(' · ') || 'None reported'}</dd><dt>Last reported fill</dt><dd>{new Date(position.lastFillAt).toISOString()}</dd></dl></li>)}</ul>
  </section>;
}
