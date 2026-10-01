import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Instrument, MarketRef, ProviderId, Quote, Watchlist } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import { BackendMarketStream, qualifiedMarket } from './PineTermProvider.js';

export function Watchlists({ client, stream, onSelectMarket, onSessionError, selectedId, onSelectList, version }: {
  client: ApiClient; stream: BackendMarketStream; onSelectMarket: (market: MarketRef) => void; onSessionError: (error: ApiError) => void;
  selectedId: string | null; onSelectList: (id: string) => void; version: number;
}) {
  const [lists, setLists] = useState<Watchlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<ProviderId>('coinbase');
  const [query, setQuery] = useState('BTC');
  const [results, setResults] = useState<Instrument[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [quoteErrors, setQuoteErrors] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  const selected = lists.find((list) => list.id === selectedId) ?? lists[0];

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void client.request<{ watchlists: Watchlist[] }>('/watchlists', { signal: controller.signal }).then(({ watchlists }) => {
      if (controller.signal.aborted) return;
      setLists(watchlists); setError(null);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
      setError(errorMessage(failure));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, version, refresh, onSessionError]);

  useEffect(() => {
    const controller = new AbortController();
    const stops: Array<() => void> = [];
    setQuotes({}); setQuoteErrors({});
    for (const market of selected?.items ?? []) {
      const key = qualifiedMarket(market);
      const params = new URLSearchParams({ provider: market.provider, symbol: market.symbol });
      void client.request<Quote>(`/quotes?${params}`, { signal: controller.signal }).then((quote) => {
        if (!controller.signal.aborted) setQuotes((current) => ({ ...current, [key]: quote }));
      }).catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
        setQuoteErrors((current) => ({ ...current, [key]: errorMessage(failure) }));
      });
      if (market.provider !== 'csv') stops.push(stream.subscribe(market, '1', 'quotes', (frame) => {
        if (frame.type === 'quote' && 'price' in frame.payload) {
          setQuotes((current) => ({ ...current, [key]: frame.payload as Quote }));
          setQuoteErrors((current) => { const next = { ...current }; delete next[key]; return next; });
        } else if (frame.type === 'status' && 'message' in frame.payload && frame.payload.status !== 'live') {
          const message = frame.payload.message ?? 'Quote unavailable.';
          setQuoteErrors((current) => ({ ...current, [key]: message }));
          setQuotes((current) => current[key] ? { ...current, [key]: { ...current[key], status: 'stale' } } : current);
        }
      }));
    }
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => { controller.abort(); for (const stop of stops) stop(); window.clearInterval(timer); };
  }, [client, stream, selected, onSessionError]);

  async function command(action: 'create' | 'rename' | 'delete' | 'items', items?: MarketRef[]) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (action === 'delete' && selected) {
        await client.request<void>(`/watchlists/${selected.id}`, { method: 'DELETE', csrf: true });
        setLists((current) => current.filter((list) => list.id !== selected.id));
      } else {
        const { watchlist } = await client.request<{ watchlist: Watchlist }>(action === 'create' ? '/watchlists' : `/watchlists/${selected!.id}`, {
          method: action === 'create' ? 'POST' : 'PUT', csrf: true,
          body: action === 'create' ? { name: name.trim(), items: [] } : { revision: selected!.revision, name: action === 'rename' ? name.trim() : selected!.name, items: items ?? selected!.items },
        });
        setLists((current) => action === 'create' ? [...current, watchlist] : current.map((list) => list.id === watchlist.id ? watchlist : list));
        onSelectList(watchlist.id); setName('');
      }
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
      setError(failure instanceof ApiError && failure.status === 409 ? 'This watchlist changed elsewhere. Refresh it before trying again; no order was overwritten.' : errorMessage(failure));
    } finally { setBusy(false); }
  }
  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const params = new URLSearchParams({ provider, q: query });
      const { markets } = await client.request<{ markets: Instrument[] }>(`/markets?${params}`);
      setResults(markets.slice(0, 30));
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
      setError(errorMessage(failure));
    } finally { setBusy(false); }
  }

  return <section className="watchlist-pane" aria-label="Named watchlists" aria-busy={busy || loading}>
    <div className="pane-title"><h2>Watchlists</h2><button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={busy}>Refresh</button></div>
    {error && <p className="message error" role="alert">{error}</p>}
    {loading && <p role="status">Loading saved watchlists…</p>}
    <label className="control-label" htmlFor="watchlist-select">Saved list</label>
    <select id="watchlist-select" value={selected?.id ?? ''} onChange={(event) => onSelectList(event.target.value)} disabled={busy || !lists.length}>
      {!lists.length && <option value="">No watchlists yet</option>}
      {lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
    </select>
    <form className="list-name-form" onSubmit={(event) => { event.preventDefault(); void command('create'); }}>
      <label className="control-label" htmlFor="watchlist-name">List name</label>
      <input id="watchlist-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="e.g. Spot markets" disabled={busy} />
      <div className="compact-actions"><button type="submit" disabled={busy || !name.trim()}>New list</button><button type="button" disabled={busy || !selected || !name.trim()} onClick={() => void command('rename')}>Rename</button><button type="button" disabled={busy || !selected} onClick={() => { if (window.confirm(`Delete watchlist “${selected?.name}”?`)) void command('delete'); }}>Delete</button></div>
    </form>
    <div className="watchlist-columns" aria-hidden="true"><span>Instrument</span><span>Last / change</span></div>
    <ol className="watchlist-rows">
      {(selected?.items ?? []).map((market, index) => {
        const key = qualifiedMarket(market); const quote = quotes[key]; const stale = quote?.status === 'stale' || (quote?.status === 'live' && now - quote.observedAt > 30_000);
        return <li key={key}>
          <button type="button" className="watchlist-market" onClick={() => onSelectMarket(market)}>
            <span><strong>{market.symbol}</strong><small>{market.provider.toUpperCase()}</small></span>
            <span className="quote-value"><strong>{quote?.price ?? '—'}</strong><small className={quote?.changePercent == null ? 'muted' : quote.changePercent >= 0 ? 'positive' : 'negative'}>{quote?.changePercent == null ? 'Change unknown' : `${quote.changePercent >= 0 ? '+' : '−'}${Math.abs(quote.changePercent).toFixed(2)}%`}</small></span>
          </button>
          <div className="watchlist-row-meta"><span title={quoteErrors[key]}>{quoteErrors[key] ? 'Unavailable / stale' : quote ? quote.status === 'historical' ? 'Historical close' : stale ? 'Stale quote' : 'Observed quote' : 'Loading quote…'}</span><span>{quote ? new Date(quote.observedAt).toLocaleTimeString() : ''}</span></div>
          <div className="row-actions"><button type="button" aria-label={`Move ${key} up`} disabled={busy || index === 0} onClick={() => { const items = [...selected!.items]; [items[index - 1], items[index]] = [items[index]!, items[index - 1]!]; void command('items', items); }}>↑</button><button type="button" aria-label={`Move ${key} down`} disabled={busy || index === selected!.items.length - 1} onClick={() => { const items = [...selected!.items]; [items[index], items[index + 1]] = [items[index + 1]!, items[index]!]; void command('items', items); }}>↓</button><button type="button" aria-label={`Remove ${key}`} disabled={busy} onClick={() => void command('items', selected!.items.filter((_, row) => row !== index))}>Remove</button></div>
        </li>;
      })}
    </ol>
    {selected && selected.items.length === 0 && <p className="muted">This list is empty. Search a named venue to add an instrument.</p>}
    <form className="market-search" onSubmit={(event) => void search(event)}>
      <label className="control-label" htmlFor="watchlist-provider">Provider</label><select id="watchlist-provider" value={provider} onChange={(event) => { setProvider(event.target.value as ProviderId); setResults([]); }}><option value="coinbase">Coinbase Exchange</option><option value="binance">Binance Spot</option><option value="csv">Imported CSV</option></select>
      <label className="control-label" htmlFor="watchlist-query">Find instrument</label><div className="search-row"><input id="watchlist-query" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={100} /><button type="submit" disabled={busy}>Search</button></div>
    </form>
    <ul className="search-results">{results.map((instrument) => {
      const key = qualifiedMarket(instrument.market); const included = selected?.items.some((item) => qualifiedMarket(item) === key);
      return <li key={key}><button type="button" className="market-result" onClick={() => onSelectMarket(instrument.market)}><strong>{instrument.market.symbol}</strong><small>{instrument.name}</small></button><button type="button" disabled={busy || !selected || included} aria-label={`Add ${key} to watchlist`} onClick={() => void command('items', [...selected!.items, instrument.market])}>{included ? 'Added' : 'Add'}</button></li>;
    })}</ul>
    <p className="muted pane-footnote">Last observed prices, not executable bids/asks. “Change unknown” is not zero.</p>
  </section>;
}
