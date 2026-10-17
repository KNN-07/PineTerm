import { useEffect, useState } from 'react';
import type { Instrument, MarketRef, ProviderId, Quote, Watchlist } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import { Dropdown, MenuItem } from '../../Dropdown.js';
import { Icon } from '../../icons.js';
import { Modal } from '../../Modal.js';
import { BackendMarketStream, qualifiedMarket } from './PineTermProvider.js';

const PROVIDERS: Array<{ id: ProviderId; label: string }> = [
  { id: 'coinbase', label: 'Coinbase' },
  { id: 'binance', label: 'Binance' },
  { id: 'csv', label: 'Imported CSV' },
];
const providerLabel = (provider: ProviderId) => PROVIDERS.find((item) => item.id === provider)?.label ?? provider;
const changeText = (value: number | null | undefined) => value == null ? '—' : `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`;
const changeTone = (value: number | null | undefined) => value == null ? 'muted' : value >= 0 ? 'positive' : 'negative';

export function Watchlists({ client, stream, activeMarket, onSelectMarket, onSessionError, selectedId, onSelectList, version }: {
  client: ApiClient; stream: BackendMarketStream; activeMarket: MarketRef | null; onSelectMarket: (market: MarketRef) => void; onSessionError: (error: ApiError) => void;
  selectedId: string | null; onSelectList: (id: string) => void; version: number;
}) {
  const [lists, setLists] = useState<Watchlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState<'create' | 'rename' | null>(null);
  const [name, setName] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [quoteErrors, setQuoteErrors] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const selected = lists.find((list) => list.id === selectedId) ?? lists[0];
  const activeKey = activeMarket ? qualifiedMarket(activeMarket) : null;

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

  async function command(action: 'create' | 'rename' | 'delete' | 'items', items?: MarketRef[]): Promise<boolean> {
    if (busy) return false;
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
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
      setError(failure instanceof ApiError && failure.status === 409 ? 'This watchlist changed elsewhere. Refresh it before trying again; no order was overwritten.' : errorMessage(failure));
      return false;
    } finally { setBusy(false); }
  }
  function move(index: number, offset: -1 | 1) {
    const items = [...selected!.items];
    [items[index], items[index + offset]] = [items[index + offset]!, items[index]!];
    void command('items', items);
  }

  const items = selected?.items ?? [];
  const detailMarket = items.find((market) => qualifiedMarket(market) === focusKey) ?? items.find((market) => qualifiedMarket(market) === activeKey) ?? null;
  const detailKey = detailMarket ? qualifiedMarket(detailMarket) : null;
  const detailQuote = detailKey ? quotes[detailKey] : undefined;
  const quoteState = (key: string, quote: Quote | undefined) => {
    const stale = quote?.status === 'stale' || (quote?.status === 'live' && now - quote.observedAt > 30_000);
    return quoteErrors[key] ? 'Unavailable / stale' : quote ? quote.status === 'historical' ? 'Historical close' : stale ? 'Stale quote' : 'Observed quote' : 'Loading quote…';
  };

  return <section className="watchlist-pane" aria-label="Named watchlists" aria-busy={busy || loading}>
    <header className="widget-header">
      <Dropdown className="list-menu" buttonClassName="tv-toolbar-button widget-title" title="Watchlists" disabled={loading && !lists.length} label={<><span>{selected?.name ?? 'Watchlist'}</span><Icon name="chevronDown" size={14} /></>}>{(close) => <>
        <div className="tv-menu-title">Watchlists</div>
        <div className="tv-menu-list">
          {lists.map((list) => <MenuItem key={list.id} checked={list.id === selected?.id} icon={list.id === selected?.id ? <Icon name="check" /> : null} hint={String(list.items.length)} disabled={busy} onSelect={() => { close(); onSelectList(list.id); }}>{list.name}</MenuItem>)}
          {!lists.length && <p className="tv-menu-footnote">No watchlists yet.</p>}
        </div>
        <div className="tv-menu-separator" />
        <MenuItem icon={<Icon name="plus" />} disabled={busy} onSelect={() => { close(); setName(''); setNaming('create'); }}>Create new list…</MenuItem>
        <MenuItem icon={<Icon name="code" />} disabled={busy || !selected} onSelect={() => { close(); setName(selected?.name ?? ''); setNaming('rename'); }}>Rename list…</MenuItem>
        <MenuItem icon={<Icon name="trash" />} danger disabled={busy || !selected} onSelect={() => { close(); if (window.confirm(`Delete watchlist “${selected?.name}”?`)) void command('delete'); }}>Delete list</MenuItem>
      </>}</Dropdown>
      <span className="toolbar-spacer" />
      <button type="button" className="tv-icon-button" title="Add symbol" aria-label="Add symbol" disabled={busy || !selected} onClick={() => setSearchOpen(true)}><Icon name="plus" /></button>
      <button type="button" className="tv-icon-button" title="Refresh" aria-label="Refresh watchlists" disabled={busy} onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" /></button>
    </header>
    {error && <p className="message error" role="alert">{error}</p>}
    {loading && !lists.length && <p className="widget-empty" role="status">Loading saved watchlists…</p>}
    <div className="wl-columns" aria-hidden="true"><span>Symbol</span><span>Last</span><span>Chg%</span></div>
    <ol className="wl-rows">
      {items.map((market, index) => {
        const key = qualifiedMarket(market); const quote = quotes[key];
        const state = quoteState(key, quote);
        return <li key={key} className={`${key === activeKey ? 'is-active' : ''} ${key === detailKey ? 'is-focused' : ''}`}>
          <button type="button" className="wl-row" title={`${key} · ${state}${quoteErrors[key] ? ` · ${quoteErrors[key]}` : ''}`} onClick={() => { setFocusKey(key); onSelectMarket(market); }}>
            <span className="wl-symbol"><span className={`symbol-logo provider-${market.provider}`} aria-hidden="true">{market.symbol.slice(0, 1)}</span><strong>{market.symbol}</strong>{state !== 'Observed quote' && <span className="wl-flag" aria-label={state} title={state}>!</span>}</span>
            <span className="wl-last">{quote?.price ?? '—'}</span>
            <span className={`wl-chg ${changeTone(quote?.changePercent)}`}>{changeText(quote?.changePercent)}</span>
          </button>
          <span className="wl-row-actions">
            <button type="button" className="tv-icon-button" aria-label={`Move ${key} up`} title="Move up" disabled={busy || index === 0} onClick={() => move(index, -1)}><Icon name="arrowUp" size={14} /></button>
            <button type="button" className="tv-icon-button" aria-label={`Move ${key} down`} title="Move down" disabled={busy || index === items.length - 1} onClick={() => move(index, 1)}><Icon name="arrowDown" size={14} /></button>
            <button type="button" className="tv-icon-button" aria-label={`Remove ${key}`} title="Remove from watchlist" disabled={busy} onClick={() => void command('items', items.filter((_, row) => row !== index))}><Icon name="close" size={14} /></button>
          </span>
        </li>;
      })}
    </ol>
    {selected && items.length === 0 && <div className="widget-empty"><p>This list is empty.</p><button type="button" onClick={() => setSearchOpen(true)}><Icon name="plus" size={16} />Add symbol</button></div>}
    {!loading && !selected && !error && <div className="widget-empty"><p>No watchlists yet.</p><button type="button" onClick={() => { setName(''); setNaming('create'); }}><Icon name="plus" size={16} />Create a list</button></div>}
    {detailMarket && detailKey && <section className="wl-details" aria-label={`${detailKey} details`}>
      <div className="wl-details-heading"><span className={`symbol-logo provider-${detailMarket.provider}`} aria-hidden="true">{detailMarket.symbol.slice(0, 1)}</span><div><strong>{detailMarket.symbol}</strong><small>{providerLabel(detailMarket.provider)} · {detailMarket.provider.toUpperCase()}</small></div></div>
      <div className="wl-details-price"><strong>{detailQuote?.price ?? '—'}</strong><span className={changeTone(detailQuote?.changePercent)}>{detailQuote?.changePercent == null ? 'Change unknown' : changeText(detailQuote.changePercent)}</span></div>
      <small className={quoteErrors[detailKey] ? 'negative' : 'muted'} title={quoteErrors[detailKey]}>{quoteState(detailKey, detailQuote)}{detailQuote ? ` · ${new Date(detailQuote.observedAt).toLocaleTimeString()}` : ''}</small>
    </section>}
    <p className="muted pane-footnote">Last observed prices, not executable bids/asks. “—” change is unknown, not zero.</p>
    {naming && <Modal title={naming === 'create' ? 'Create new list' : 'Rename list'} titleId="watchlist-name-title" onClose={() => setNaming(null)} closeDisabled={busy}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); void command(naming).then((ok) => { if (ok) setNaming(null); }); }}>
        <div className="form-field"><label htmlFor="watchlist-name">List name</label><input id="watchlist-name" data-autofocus value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="e.g. Spot markets" disabled={busy} /></div>
        {error && <p className="message error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" onClick={() => setNaming(null)} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy || !name.trim()}>{naming === 'create' ? 'Create' : 'Rename'}</button></div>
      </form>
    </Modal>}
    {searchOpen && <SymbolSearch client={client} included={new Set(items.map(qualifiedMarket))} busy={busy} onClose={() => setSearchOpen(false)} onSessionError={onSessionError}
      onOpen={(market) => { setSearchOpen(false); onSelectMarket(market); }}
      onAdd={(market) => void command('items', [...items, market])} />}
  </section>;
}

/** TradingView-style symbol search: type to search one named venue, open or add a result. */
function SymbolSearch({ client, included, busy, onClose, onOpen, onAdd, onSessionError }: {
  client: ApiClient; included: Set<string>; busy: boolean; onClose: () => void; onOpen: (market: MarketRef) => void; onAdd: (market: MarketRef) => void; onSessionError: (error: ApiError) => void;
}) {
  const [provider, setProvider] = useState<ProviderId>('coinbase');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Instrument[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true); setError(null);
      void client.request<{ markets: Instrument[] }>(`/markets?${new URLSearchParams({ provider, q: query.trim() })}`, { signal: controller.signal })
        .then(({ markets }) => { if (!controller.signal.aborted) setResults(markets.slice(0, 50)); })
        .catch((failure: unknown) => {
          if (controller.signal.aborted) return;
          if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
          setError(errorMessage(failure)); setResults([]);
        })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 220);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [client, provider, query, onSessionError]);
  return <Modal title="Symbol search" titleId="symbol-search-title" onClose={onClose}>
    <div className="symbol-search">
      <label className="symbol-search-input"><Icon name="search" /><input data-autofocus aria-label="Find instrument" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={100} placeholder="Symbol, e.g. BTC" /></label>
      <div className="symbol-search-sources" role="tablist" aria-label="Venue">{PROVIDERS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={provider === item.id} onClick={() => { setProvider(item.id); setResults([]); }}>{item.label}</button>)}</div>
      {error && <p className="message error" role="alert">{error}</p>}
      <ul className="symbol-search-results" aria-busy={searching}>
        {results.map((instrument) => {
          const key = qualifiedMarket(instrument.market); const added = included.has(key);
          return <li key={key}>
            <button type="button" className="symbol-search-open" onClick={() => onOpen(instrument.market)}><span className={`symbol-logo provider-${instrument.market.provider}`} aria-hidden="true">{instrument.market.symbol.slice(0, 1)}</span><strong>{instrument.market.symbol}</strong><span className="symbol-search-name">{instrument.name}</span><span className="symbol-search-venue">{instrument.market.provider.toUpperCase()}</span></button>
            <button type="button" className="tv-icon-button" disabled={busy || added} aria-label={added ? `${key} is in the watchlist` : `Add ${key} to watchlist`} title={added ? 'In watchlist' : 'Add to watchlist'} onClick={() => onAdd(instrument.market)}><Icon name={added ? 'check' : 'plus'} /></button>
          </li>;
        })}
        {!searching && !error && !results.length && <li className="widget-empty">No instruments match on {providerLabel(provider)}.</li>}
        {searching && !results.length && <li className="widget-empty" role="status">Searching {providerLabel(provider)}…</li>}
      </ul>
    </div>
  </Modal>;
}
