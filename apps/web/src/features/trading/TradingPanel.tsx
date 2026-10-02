import { useCallback, useEffect, useRef, useState } from 'react';
import type { Instrument, InvalidationEvent, PaperAccount, PaperAccountView, PaperOrder, PaperOrderRequest, ReplaySession } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import type { ActiveChart } from '../workspace/ChartWorkspace.js';
import { qualifiedMarket } from '../workspace/PineTermProvider.js';
import './trading.css';

interface PendingPlacement { key: string; body: PaperOrderRequest }
export function TradingPanel({ client, active, replay, replayReady, onSessionError }: {
  client: ApiClient; active: ActiveChart; replay: ReplaySession | null; replayReady: boolean; onSessionError: (error: ApiError) => void;
}) {
  const [accounts, setAccounts] = useState<PaperAccount[]>([]); const [selected, setSelected] = useState(''); const [view, setView] = useState<PaperAccountView | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState(''); const [currency, setCurrency] = useState('USD'); const [balance, setBalance] = useState('10000'); const [fees, setFees] = useState('10'); const [slip, setSlip] = useState('0');
  const [side, setSide] = useState<'buy' | 'sell'>('buy'); const [type, setType] = useState<'market' | 'limit' | 'stop'>('market'); const [quantity, setQuantity] = useState(''); const [price, setPrice] = useState('');
  const [instrument, setInstrument] = useState<Instrument | null>(null);
  const [pending, setPending] = useState<PendingPlacement | null>(null); const inFlight = useRef(false);
  const accountId = replay?.accountId ?? selected; const accountRef = useRef(accountId); accountRef.current = accountId;
  const fail = useCallback((failure: unknown) => {
    setError(errorMessage(failure));
    if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
  }, [onSessionError]);
  const refresh = useCallback(async () => {
    const id = accountRef.current;
    const [{ accounts: records }, detail] = await Promise.all([
      client.request<{ accounts: PaperAccount[] }>('/paper/accounts'),
      id ? client.request<PaperAccountView>(`/paper/accounts/${id}`) : Promise.resolve(null),
    ]);
    setAccounts(records);
    if (accountRef.current === id) setView(detail);
    if (!id) setSelected(records.find(account => account.mode === 'live' && !account.archivedAt)?.id ?? '');
  }, [client]);
  useEffect(() => { setView(null); setNotice(null); setError(null); void refresh().catch(fail); }, [accountId, refresh, fail]);
  useEffect(() => {
    let alive = true;
    setInstrument(null);
    if (active.market) {
      const market = active.market;
      void client.request<{ markets: Instrument[] }>(`/markets?${new URLSearchParams({ provider: market.provider, q: market.symbol })}`).then(({ markets }) => {
        if (alive) setInstrument(markets.find(item => item.market.symbol === market.symbol) ?? null);
      }).catch(failure => { if (alive) fail(failure); });
    }
    return () => { alive = false; };
  }, [client, active.market?.provider, active.market?.symbol, fail]);
  useEffect(() => {
    const source = new EventSource('/api/v1/events');
    source.onopen = () => { void refresh().catch(fail); };
    source.addEventListener('invalidation', event => {
      const data: InvalidationEvent = JSON.parse((event as MessageEvent<string>).data);
      if (data.type === 'paper.changed') void refresh().catch(fail);
    });
    return () => source.close();
  }, [refresh, fail]);
  useEffect(() => {
    if (replay || !view?.positions.length) return;
    // Server invalidations handle fills; valuation also refetches fresh authoritative quotes without client accounting.
    const timer = window.setInterval(() => void refresh().catch(fail), 15_000);
    return () => window.clearInterval(timer);
  }, [replay, view?.positions.length, refresh, fail]);

  async function command(action: 'create' | 'reset' | 'cancel', orderId?: string) {
    if (inFlight.current) return;
    if ((action === 'create' || action === 'reset') && replay) return;
    if (action === 'reset' && !window.confirm(`Archive this PAPER account and its ledger, cancel pending orders, and create a fresh ${view?.account.initialBalance} ${view?.account.quoteCurrency} account? No actual funds are affected.`)) return;
    inFlight.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      if (action === 'create') {
        const result = await client.request<PaperAccountView>('/paper/accounts', { method: 'POST', csrf: true, body: { name: name.trim(), quoteCurrency: currency, initialBalance: balance, commissionBps: fees, slippageBps: slip } });
        accountRef.current = result.account.id; setSelected(result.account.id); setView(result); setName(''); setNotice('Paper spot account created. No real funds or currency conversion.');
      } else if (action === 'reset') {
        const fresh = await client.request<PaperAccountView>(`/paper/accounts/${accountId}/reset`, { method: 'POST', csrf: true, body: { confirm: true } });
        accountRef.current = fresh.account.id; setSelected(fresh.account.id); setView(fresh); setNotice('Old ledger preserved in its archived account; fresh paper account selected.');
      } else await client.request(`/paper/orders/${orderId}/cancel`, { method: 'POST', csrf: true });
      await refresh();
    } catch (failure) { fail(failure); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function place(retry = false) {
    if (inFlight.current || !active.market || !view || view.account.archivedAt || (replay && !replayReady)) return;
    if (replay ? view.account.id !== replay.accountId || view.account.mode !== 'replay' : view.account.mode !== 'live') { setError('The order ticket is not bound to the correct live/replay account.'); return; }
    let placement: PendingPlacement;
    if (retry && pending) placement = pending;
    else {
      if (pending) { setError('Resolve the previous request with Retry identical request before submitting a different order.'); return; }
      placement = { key: crypto.randomUUID(), body: { accountId: view.account.id, market: active.market, side, type, quantity, ...(type === 'limit' ? { limitPrice: price } : type === 'stop' ? { stopPrice: price } : {}) } };
      setPending(placement);
    }
    if (placement.body.accountId !== accountId) { setError('The unresolved request belongs to another account. Return to that account to retry it.'); return; }
    inFlight.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const { order } = await client.request<{ order: PaperOrder }>('/paper/orders', { method: 'POST', csrf: true, headers: { 'Idempotency-Key': placement.key }, body: placement.body });
      setPending(null); setNotice(`Accepted order ${order.id.slice(0, 8)}. Current state appears in server orders and fills below.`);
      await refresh();
    } catch (failure) {
      // Ambiguous network/unreadable replies retain the exact body/key for an explicit identical retry. Never automatically retry a trade.
      if (failure instanceof ApiError && failure.status !== 0 && failure.code !== 'INVALID_RESPONSE') setPending(null);
      fail(failure);
    } finally { inFlight.current = false; setBusy(false); }
  }
  const locked = busy || pending !== null;
  const account = view?.account;
  const available = !replay || replayReady;

  return <section className="trading-panel" aria-label="Paper spot trading">
    <div className="paper-boundary"><strong>{replay ? 'REPLAY PAPER · isolated ledger' : 'LIVE PAPER · simulated spot only'}</strong><span>No leverage, shorts, implicit USD/USDT conversion or real orders. {replay ? 'Only this replay account can receive ticket orders.' : 'Market orders wait for the first fresh observed quote after acceptance.'}</span></div>
    <div className="paper-account-toolbar">
      <label>Paper account<select aria-label="Paper account" value={accountId} disabled={busy || !!pending || !!replay} onChange={event => setSelected(event.target.value)}>
        {!accountId && <option value="">Create an account</option>}
        {replay ? <option value={replay.accountId}>Replay · {replay.accountId.slice(0, 8)}</option> : accounts.filter(item => item.mode === 'live').map(item => <option key={item.id} value={item.id}>{item.name} · {item.quoteCurrency}{item.archivedAt ? ' · archived' : ''}</option>)}
      </select></label>
      <button type="button" disabled={busy} onClick={() => void refresh().catch(fail)}>Refresh server</button>
      {account && !replay && <button type="button" className="danger" disabled={locked || !!account.archivedAt} onClick={() => void command('reset')}>Reset paper account…</button>}
      {!replay && <details><summary>New paper account</summary><form className="paper-create" onSubmit={event => { event.preventDefault(); void command('create'); }}>
        <label>Name<input aria-label="Paper account name" value={name} maxLength={100} onChange={event => setName(event.target.value)} disabled={locked} required /></label>
        <label>Quote currency<input aria-label="Paper quote currency" value={currency} maxLength={20} onChange={event => setCurrency(event.target.value.toUpperCase())} disabled={locked} required /></label>
        <label>Initial cash<input inputMode="decimal" value={balance} onChange={event => setBalance(event.target.value)} disabled={locked} required /></label>
        <label>Commission · bps<input inputMode="decimal" value={fees} onChange={event => setFees(event.target.value)} disabled={locked} required /></label>
        <label>Adverse slippage · bps<input inputMode="decimal" value={slip} onChange={event => setSlip(event.target.value)} disabled={locked} required /></label>
        <button type="submit" disabled={locked || !name.trim()}>Create paper account</button>
      </form></details>}
    </div>
    {error && <p role="alert" className="negative">{error}</p>}{notice && <p role="status">{notice}</p>}
    {pending && <div className="paper-boundary"><span>Unresolved placement · {qualifiedMarket(pending.body.market)} · {pending.body.side} {pending.body.quantity}. Exact body and idempotency key retained; no automatic retry.</span><button type="button" disabled={busy || pending.body.accountId !== accountId || !available} onClick={() => void place(true)}>Retry identical request</button></div>}
    {view && account ? <>
      <div className="paper-balances"><span>Cash <strong>{account.cashBalance} {account.quoteCurrency}</strong></span><span>Reserved <strong>{account.reservedCash}</strong></span><span>Available <strong>{account.availableCash}</strong></span><span>Commission <strong>{account.commissionBps} bps</strong></span><span>Adverse slippage <strong>{account.slippageBps} bps</strong></span></div>
      {account.archivedAt ? <p>Archived account · immutable trading history. Select or create an active account.</p> : <form className="paper-ticket" onSubmit={event => { event.preventDefault(); void place(); }}>
        <strong>{active.market ? qualifiedMarket(active.market) : 'Select a chart market'} · {account.quoteCurrency} cash account</strong>
        <label>Side<select aria-label="Paper order side" value={side} onChange={event => setSide(event.target.value as 'buy' | 'sell')} disabled={locked}><option value="buy">Buy</option><option value="sell">Sell owned quantity</option></select></label>
        <label>Type<select aria-label="Paper order type" value={type} onChange={event => setType(event.target.value as 'market' | 'limit' | 'stop')} disabled={locked}><option value="market">Market</option><option value="limit">Limit</option><option value="stop">Stop</option></select></label>
        <label>Quantity<input aria-label="Paper order quantity" inputMode="decimal" value={quantity} onChange={event => setQuantity(event.target.value)} disabled={locked} placeholder="Canonical decimal" required /></label>
        {type !== 'market' && <label>{type === 'limit' ? 'Limit price' : 'Stop trigger'}<input aria-label="Paper order price" inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} disabled={locked} required /></label>}
        <button type="submit" disabled={locked || !available || !active.market || !quantity || !instrument || instrument.quoteCurrency !== account.quoteCurrency || (!replay && active.market.provider === 'csv')}>{busy ? 'Awaiting server…' : `Place ${replay ? 'replay' : 'paper'} ${side}`}</button>
        <small>{!available ? 'Replay chart/server acknowledgement pending or failed: ticket disabled.' : !instrument ? 'Loading server instrument metadata…' : instrument.quoteCurrency !== account.quoteCurrency ? `Chart-only: ${instrument.quoteCurrency} does not match this ${account.quoteCurrency} account. No FX conversion.` : !replay && active.market?.provider === 'csv' ? 'Imported history is chart-only in live paper; use replay for historical fills.' : `${instrument.baseCurrency}/${instrument.quoteCurrency} · quantity step ${instrument.quantityStep} · price tick ${instrument.tickSize}. Server checks all values; no client fill price is submitted.`}</small>
      </form>}
      <details open><summary>Open orders · {view.orders.filter(order => order.state === 'open').length}</summary><div className="trading-table-scroll"><table><thead><tr><th>Market</th><th>Order</th><th>Quantity</th><th>Reservation</th><th>State / waiting reason</th><th>Action</th></tr></thead><tbody>{view.orders.filter(order => order.state === 'open').map(order => <tr key={order.id}><td>{qualifiedMarket(order.market)}</td><td>{order.side} {order.type}{order.limitPrice ? ` @ ${order.limitPrice}` : order.stopPrice ? ` trigger ${order.stopPrice}` : ''}</td><td>{order.quantity}</td><td>{order.side === 'buy' ? `${order.reservedCash} ${account.quoteCurrency}` : order.reservedQuantity}</td><td>{order.state} · {order.waitingReason ?? 'waiting for eligible server data'}</td><td><button type="button" disabled={busy} onClick={() => void command('cancel', order.id)}>Cancel</button></td></tr>)}</tbody></table></div></details>
      <details open><summary>Holdings · realized / unrealized P/L</summary><div className="trading-table-scroll"><table><thead><tr><th>Market</th><th>Owned / reserved</th><th>Average cost</th><th>Market value</th><th>Realized P/L</th><th>Unrealized P/L</th><th>Quote status</th></tr></thead><tbody>{view.positions.map(position => <tr key={position.id}><td>{qualifiedMarket(position.market)}</td><td>{position.quantity} / {position.reservedQuantity}</td><td>{position.averageCost ?? '—'}</td><td>{position.marketValue ?? 'Unavailable'}</td><td>{position.realizedPnl} {account.quoteCurrency}</td><td>{position.unrealizedPnl === null ? 'Unavailable' : `${position.unrealizedPnl} ${account.quoteCurrency}`}</td><td>{position.quoteStatus}{position.quoteObservedAt ? ` · ${new Date(position.quoteObservedAt).toISOString()}` : ''}</td></tr>)}</tbody></table></div>{!view.positions.length && <p>No holdings. Portfolio values are never seeded.</p>}</details>
      <details><summary>Fills · {view.fills.length}</summary><div className="trading-table-scroll"><table><thead><tr><th>UTC time</th><th>Market</th><th>Side / quantity</th><th>Raw simulated fill</th><th>Fee</th></tr></thead><tbody>{view.fills.map(fill => <tr key={fill.id}><td>{new Date(fill.occurredAt).toISOString()}</td><td>{qualifiedMarket(fill.market)}</td><td>{fill.side} {fill.quantity}</td><td>{fill.price} {fill.currency}</td><td>{fill.fee} {fill.currency}</td></tr>)}</tbody></table></div></details>
      <details><summary>Cash ledger · {view.ledger.length} entries</summary><div className="trading-table-scroll"><table><thead><tr><th>UTC time</th><th>Kind</th><th>Cash change</th><th>Cash after</th><th>Audit detail</th></tr></thead><tbody>{view.ledger.map(entry => <tr key={entry.id}><td>{new Date(entry.occurredAt).toISOString()}</td><td>{entry.kind}</td><td>{entry.cashDelta} {account.quoteCurrency}</td><td>{entry.cashBalance}</td><td><code>{JSON.stringify(entry.details)}</code></td></tr>)}</tbody></table></div></details>
    </> : <p>{accountId ? 'Loading server account…' : 'Create a spot paper account in its exact quote currency to begin.'}</p>}
  </section>;
}
