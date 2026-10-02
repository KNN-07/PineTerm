import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ExecutionAudit, ExecutionPolicy, ExecutorRecord, UpdateExecutionPolicy } from '@pineterm/contracts';
import { errorMessage } from '../../api.js';
import { Modal } from '../../Modal.js';
import { SettingsNavigation } from '../alerts/SettingsNavigation.js';
import { ExecutionStatus, useExecution } from './ExecutionContext.js';
import { canonicalDecimal, positiveDecimal } from './LiveActionFields.js';
import { ExecutionRisk } from './ExecutionRisk.js';

interface MarketRuleDraft { provider: '' | 'coinbase' | 'binance'; symbol: string; buy: boolean; sell: boolean }
interface CurrencyLimitDraft { quoteCurrency: string; perOrderNotional: string; rolling24hNotional: string }
export function ExecutionSettings({ onClose, onOpenData, onOpenSecurity, onOpenNotifications }: {
  onClose: () => void; onOpenData: () => void; onOpenSecurity: () => void; onOpenNotifications: () => void;
}) {
  const { client, policy, executors, loading, error: loadError, policyBusy, savePolicy, refresh } = useExecution();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ExecutorRecord | null>(null);
  const [name, setName] = useState('');
  const [executorEnabled, setExecutorEnabled] = useState(false);
  const [revision, setRevision] = useState<number | null>(null);
  const [rules, setRules] = useState<MarketRuleDraft[]>([]);
  const [limits, setLimits] = useState<CurrencyLimitDraft[]>([]);
  const [maxPending, setMaxPending] = useState('');
  const [deviation, setDeviation] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [audit, setAudit] = useState<ExecutionAudit[]>([]);
  const operation = useRef(false);
  const loadedPolicy = useRef(false);
  function readPolicy(value: ExecutionPolicy) {
    setRevision(value.revision);
    setRules(value.allowlist.map((rule) => ({ provider: rule.market.provider === 'csv' ? '' : rule.market.provider, symbol: rule.market.symbol, buy: rule.sides.includes('buy'), sell: rule.sides.includes('sell') })));
    setLimits(value.quoteLimits.map((limit) => ({ ...limit })));
    setMaxPending(value.maxPending === null ? '' : String(value.maxPending)); setDeviation(value.maxDeviationBps ?? ''); setAuthorized(false);
  }
  useEffect(() => { if (policy && !loadedPolicy.current) { loadedPolicy.current = true; readPolicy(policy); } }, [policy]);
  async function mutate(task: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(null); setNotice(null);
    try { await task(); refresh(); } catch (failure) { setError(errorMessage(failure)); }
    finally { operation.current = false; setBusy(false); }
  }
  function saveExecutor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void mutate(async () => {
      const { executor } = await client.request<{ executor: ExecutorRecord }>(editing ? `/executors/${encodeURIComponent(editing.id)}` : '/executors', { method: editing ? 'PUT' : 'POST', csrf: true, body: { name: name.trim(), enabled: executorEnabled, ...(editing ? { revision: editing.revision } : {}) } });
      setEditing(null); setName(''); setExecutorEnabled(false); setNotice(`Executor “${executor.name}” ${executor.enabled ? 'enabled' : 'disabled'}. Registration does not install or connect an operator driver.`);
    });
  }
  function enablePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null);
    try {
      if (revision === null || loadError || !authorized) throw new Error('Refresh authoritative policy and explicitly authorize autonomous handoff.');
      if (!executors.some((executor) => executor.enabled && executor.archivedAt === null)) throw new Error('Enable at least one registered executor first.');
      if (!rules.length || rules.some((rule) => !rule.provider || !rule.symbol.trim() || (!rule.buy && !rule.sell))) throw new Error('Add explicit live markets and permitted sides. Empty allowlists are never unlimited.');
      if (!limits.length || limits.some((limit) => !/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(limit.quoteCurrency) || !positiveDecimal(limit.perOrderNotional) || !positiveDecimal(limit.rolling24hNotional))) throw new Error('Each quote currency requires explicit positive canonical per-order and rolling-24h limits. USD is not USDT.');
      if (!/^[1-9]\d*$/.test(maxPending) || !Number.isSafeInteger(Number(maxPending)) || Number(maxPending) > 1000) throw new Error('Maximum pending intents must be an explicit integer from 1 to 1000.');
      if (!canonicalDecimal.test(deviation) || Number(deviation) >= 10000) throw new Error('Maximum deviation must be an explicit canonical decimal from 0 to less than 10000 basis points.');
      const body: UpdateExecutionPolicy = { enabled: true, revision, allowlist: rules.map((rule) => ({ market: { provider: rule.provider as 'coinbase' | 'binance', symbol: rule.symbol.trim() }, sides: [...(rule.buy ? ['buy' as const] : []), ...(rule.sell ? ['sell' as const] : [])] })), quoteLimits: limits, maxPending: Number(maxPending), maxDeviationBps: deviation };
      void mutate(async () => { const next = await savePolicy(body); readPolicy(next); setNotice('LIVE HANDOFF ENABLED. Authorized clients and fixed fresh alert actions can hand off orders without per-order approval.'); });
    } catch (failure) { setError(errorMessage(failure)); }
  }
  const locked = busy || policyBusy;
  return <Modal title="Settings · external execution" titleId="execution-settings-title" onClose={onClose} closeDisabled={locked}>
    <div className="execution-settings">
      <SettingsNavigation active="execution" onData={onOpenData} onSecurity={onOpenSecurity} onNotifications={onOpenNotifications} onExecution={() => {}} disabled={locked} />
      <ExecutionStatus />
      <p>Opt-in pull/claim handoff to an operator-specified external driver. PineTerm never holds exchange credentials or submits to an exchange directly. Administrator sessions cannot fabricate executor acknowledgements or fills.</p>
      {error && <p className="message error" role="alert">{error}<small>Revision conflicts require refreshing and reviewing current state. No forced overwrite.</small></p>}
      {notice && <p className="message" role="status">{notice}</p>}
      <div className="actions"><button type="button" disabled={locked} onClick={refresh}>Refresh execution state</button><button type="button" onClick={onOpenSecurity} disabled={locked}>Create executor-bound API key</button></div>
      <section><h3>Registered executors</h3><p className="muted">A claim/report key binds to one registered executor. Removing a registration archives it, never erases audit or proves venue cancellation.</p>
        {!executors.length && !loading && <p>No executor registered. Live handoff cannot be enabled.</p>}
        <ul className="execution-cards">{executors.map((executor) => <li key={executor.id}><strong>{executor.name}</strong><span>{executor.archivedAt !== null ? 'Archived' : executor.enabled ? 'Enabled' : 'Disabled'} · r{executor.revision}</span><code>{executor.id}</code>{executor.claimsPausedReason && <p className="message error">New claims paused: {executor.claimsPausedReason}. The external driver must reconcile by stable client order ID; never resubmit an unknown order.</p>}{executor.archivedAt === null && <div className="actions"><button type="button" disabled={locked} onClick={() => { setEditing(executor); setName(executor.name); setExecutorEnabled(executor.enabled); setError(null); }}>Edit executor</button><button type="button" className="danger" disabled={locked} onClick={() => { if (window.confirm(`Archive “${executor.name}”? Audit remains. This does NOT guarantee cancellation at the venue.`)) void mutate(async () => { await client.request(`/executors/${encodeURIComponent(executor.id)}`, { method: 'DELETE', csrf: true }); if (editing?.id === executor.id) { setEditing(null); setName(''); setExecutorEnabled(false); } setNotice('Executor archived; audit retained. Inspect open intents and venue cancellation reports.'); }); }}>Archive executor</button></div>}</li>)}</ul>
        <form onSubmit={saveExecutor}><fieldset disabled={locked || loading}><legend>{editing ? `Edit executor · r${editing.revision}` : 'Register operator executor'}</legend><div className="form-field"><label htmlFor="execution-executor-name">Executor name</label><input id="execution-executor-name" value={name} required maxLength={100} onChange={(event) => setName(event.target.value)} /></div><label className="execution-checkbox"><input type="checkbox" checked={executorEnabled} onChange={(event) => setExecutorEnabled(event.target.checked)} />Enable this executor to claim eligible handoffs</label><div className="actions"><button type="submit" className="primary" disabled={!name.trim()}>{editing ? 'Save executor' : 'Register executor'}</button>{editing && <button type="button" onClick={() => { setEditing(null); setName(''); setExecutorEnabled(false); }}>Cancel edit</button>}</div></fieldset></form>
      </section>
      <section><div className="pane-title"><h3>Finite live handoff policy</h3><button type="button" disabled={locked || !policy || loading} onClick={() => { if (policy) { readPolicy(policy); setError(null); } }}>Reload saved policy</button></div>
        <p>Blank means unconfigured, never unlimited. Every allowlisted market needs a matching actual quote-currency limit. USD and USDT budgets are independent; submitted notional is not complete portfolio exposure.</p>
        {policy && revision !== null && policy.revision !== revision && <p className="message error" role="alert">Policy changed to r{policy.revision} while editing r{revision}. Reload saved policy before applying changes.</p>}
        <form onSubmit={enablePolicy}><fieldset disabled={locked || loading || !policy || !!loadError}>
          <legend>Explicit market / side allowlist</legend>
          {rules.map((rule, index) => <fieldset key={index} className="execution-policy-row"><legend>Market {index + 1}</legend><div className="execution-form-grid"><div className="form-field"><label htmlFor={`policy-provider-${index}`}>Venue</label><select id={`policy-provider-${index}`} required value={rule.provider} onChange={(event) => setRules((rows) => rows.map((row, offset) => offset === index ? { ...row, provider: event.target.value as MarketRuleDraft['provider'], symbol: '' } : row))}><option value="">Choose venue</option><option value="coinbase">Coinbase</option><option value="binance">Binance</option></select></div><div className="form-field"><label htmlFor={`policy-symbol-${index}`}>Exact venue symbol</label><input id={`policy-symbol-${index}`} required maxLength={100} value={rule.symbol} onChange={(event) => setRules((rows) => rows.map((row, offset) => offset === index ? { ...row, symbol: event.target.value } : row))} /></div></div><div className="actions">{(['buy', 'sell'] as const).map((side) => <label key={side} className="execution-checkbox"><input type="checkbox" checked={rule[side]} onChange={(event) => setRules((rows) => rows.map((row, offset) => offset === index ? { ...row, [side]: event.target.checked } : row))} />Permit {side}</label>)}<button type="button" onClick={() => setRules((rows) => rows.filter((_, offset) => offset !== index))}>Remove market</button></div></fieldset>)}
          <button type="button" onClick={() => setRules((rows) => [...rows, { provider: '', symbol: '', buy: false, sell: false }])}>Add explicit market</button>
          <h4>Separate quote-currency limits</h4>
          {limits.map((limit, index) => <fieldset key={index} className="execution-policy-row"><legend>Currency budget {index + 1}</legend><div className="execution-form-grid">{(['quoteCurrency', 'perOrderNotional', 'rolling24hNotional'] as const).map((field) => <div className="form-field" key={field}><label htmlFor={`policy-${field}-${index}`}>{({ quoteCurrency: 'Exact quote currency · e.g. USD or USDT', perOrderNotional: 'Maximum per-order notional', rolling24hNotional: 'Maximum rolling-24h submitted notional' } as const)[field]}</label><input id={`policy-${field}-${index}`} required inputMode={field === 'quoteCurrency' ? 'text' : 'decimal'} value={limit[field]} maxLength={field === 'quoteCurrency' ? 20 : 80} onChange={(event) => setLimits((rows) => rows.map((row, offset) => offset === index ? { ...row, [field]: event.target.value } : row))} /></div>)}</div><button type="button" onClick={() => setLimits((rows) => rows.filter((_, offset) => offset !== index))}>Remove currency budget</button></fieldset>)}
          <button type="button" onClick={() => setLimits((rows) => [...rows, { quoteCurrency: '', perOrderNotional: '', rolling24hNotional: '' }])}>Add currency budget</button>
          <div className="execution-form-grid"><div className="form-field"><label htmlFor="policy-max-pending">Maximum pending intents · 1–1000</label><input id="policy-max-pending" required inputMode="numeric" value={maxPending} onChange={(event) => setMaxPending(event.target.value)} /></div><div className="form-field"><label htmlFor="policy-deviation">Maximum price deviation · basis points</label><input id="policy-deviation" required inputMode="decimal" value={deviation} onChange={(event) => setDeviation(event.target.value)} /><small>0 to less than 10000. 100 basis points = 1%. Market drivers must enforce buy caps / sell floors.</small></div></div>
          <label className="execution-checkbox"><input type="checkbox" required checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} />I authorize these bounded autonomous handoffs from scoped clients and fixed fresh live alert actions, without per-order approval.</label>
          <button type="submit" className="danger" disabled={!authorized || !rules.length || !limits.length || revision !== policy?.revision || !executors.some((row) => row.enabled && row.archivedAt === null)}>Enable / apply live policy</button>
        </fieldset></form>
      </section>
      <ExecutionRisk />
      <section><div className="pane-title"><h3>Immutable execution audit</h3><button type="button" disabled={locked} onClick={() => void mutate(async () => { const { entries } = await client.request<{ entries: ExecutionAudit[] }>('/execution-audit'); setAudit(entries); })}>Load audit</button></div><ul className="execution-cards">{audit.map((entry) => <li key={entry.id}><strong>{entry.type}</strong><small>{new Date(entry.createdAt).toISOString()}</small><code>{entry.intentId ?? entry.executorId ?? entry.id}</code><pre>{JSON.stringify(entry.details, null, 2)}</pre></li>)}</ul></section>
    </div>
  </Modal>;
}
