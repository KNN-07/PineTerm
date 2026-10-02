import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Dataset, MarketRef, ProviderId } from '@pineterm/contracts';
import { TIMEFRAMES } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import { Modal } from '../../Modal.js';
import { SettingsNavigation } from '../alerts/SettingsNavigation.js';

interface ProviderStatus { id: ProviderId; name: string; status: string; timeframes: string[] }
export function DataSettings({ client, onClose, onOpenSecurity, onOpenNotifications, onOpenExecution, onOpenAgent, onSessionError, onDatasetImported }: {
  client: ApiClient; onClose: () => void; onOpenSecurity: () => void; onOpenNotifications: () => void; onOpenExecution: () => void; onOpenAgent: () => void; onSessionError: (error: ApiError) => void; onDatasetImported: (market: MarketRef, timeframe: string) => void;
}) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [metadata, setMetadata] = useState({ name: '', baseCurrency: 'BTC', quoteCurrency: 'USD', timeframe: '1', tickSize: '0.01', quantityStep: '0.00000001' });
  const [file, setFile] = useState<File | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void client.request<{ providers: ProviderStatus[] }>('/providers', { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setProviders(result.providers);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
      setError(errorMessage(failure));
    });
    return () => controller.abort();
  }, [client, refresh, onSessionError]);

  async function importCsv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy) return;
    if (file.size > 10 * 1024 * 1024) { setError('CSV file exceeds the 10 MiB limit.'); return; }
    setBusy(true); setError(null); setNotice(null);
    const data = new FormData();
    for (const [field, value] of Object.entries(metadata)) data.append(field, value.trim());
    data.append('file', file);
    try {
      const { dataset } = await client.request<{ dataset: Dataset }>('/datasets', { method: 'POST', body: data, csrf: true });
      setNotice(`Imported ${dataset.rowCount} validated rows as “${dataset.name}”. Historical data only; live execution is unavailable.`);
      setRefresh((value) => value + 1);
      onDatasetImported({ provider: 'csv', symbol: dataset.id }, dataset.timeframe);
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure);
      const details = failure instanceof ApiError && failure.details ? ` Details: ${JSON.stringify(failure.details)}` : '';
      setError(`${errorMessage(failure)}${details}`);
    } finally { setBusy(false); }
  }
  return <Modal title="Settings · data & integrations" titleId="data-settings-title" onClose={onClose} closeDisabled={busy}>
    <SettingsNavigation active="data" onData={() => {}} onSecurity={onOpenSecurity} onNotifications={onOpenNotifications} onExecution={onOpenExecution} onAgent={onOpenAgent} disabled={busy} />
    {error && <p className="message error" role="alert">{error}</p>}
    {notice && <p className="message" role="status">{notice}</p>}
    <section><div className="pane-title"><h3>Authoritative data sources</h3><button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={busy}>Refresh</button></div>
      <p>Charts connect only to your PineTerm server. Venues stay qualified; Binance USDT and Coinbase USD are never silently merged or substituted.</p>
      <ul className="provider-list">{providers.map((provider) => <li key={provider.id}><strong>{provider.name}</strong><span>{provider.status}</span><small>Intervals: {provider.timeframes.join(', ')}</small></li>)}</ul>
      <p className="muted">Provider availability is observed per request. A configured source is not a guarantee that its exchange is reachable from this deployment.</p>
    </section>
    <section><h3>Import historical OHLCV</h3><p>Exact header: <code>time,open,high,low,close,volume</code>. Use UTC ISO-8601 with <code>Z</code> or epoch milliseconds, never seconds. Imports are validated atomically, sorted, and visibly historical.</p>
      <form onSubmit={(event) => void importCsv(event)}><fieldset disabled={busy} className="import-fields">
        {(['name', 'baseCurrency', 'quoteCurrency', 'tickSize', 'quantityStep'] as const).map((field) => <div className="form-field" key={field}><label htmlFor={`csv-${field}`}>{({ name: 'Dataset name', baseCurrency: 'Base currency', quoteCurrency: 'Quote currency', tickSize: 'Tick size', quantityStep: 'Quantity step' } as const)[field]}</label><input id={`csv-${field}`} value={metadata[field]} onChange={(event) => setMetadata((current) => ({ ...current, [field]: event.target.value }))} required maxLength={field === 'name' ? 100 : 40} /></div>)}
        <div className="form-field"><label htmlFor="csv-timeframe">Native interval</label><select id="csv-timeframe" value={metadata.timeframe} onChange={(event) => setMetadata((current) => ({ ...current, timeframe: event.target.value }))}>{TIMEFRAMES.map((value) => <option key={value} value={value}>{value === 'D' ? '1 day' : value === 'W' ? '1 week' : value === 'M' ? '1 month' : `${value} minutes`}</option>)}</select></div>
        <div className="form-field full-width"><label htmlFor="csv-file">CSV file · maximum 10 MiB</label><input id="csv-file" type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required /></div>
        <button type="submit" className="primary" disabled={!file}>{busy ? 'Validating import…' : 'Import & open chart'}</button>
      </fieldset></form>
    </section>
    <section className="readiness-note"><h3>Other integrations</h3><p>Configure signed webhooks and a dedicated Telegram bot under Notifications. Register operator executors and explicitly bounded autonomous handoff under Execution. Configure a real analysis-only model under Pi; no model is selected or credentialed by default.</p></section>
  </Modal>;
}
