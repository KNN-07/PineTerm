import type { ExecutorRecord, LiveAction, MarketRef } from '@pineterm/contracts';

export interface LiveActionDraft {
  executorId: string; provider: '' | 'binance' | 'coinbase'; symbol: string;
  side: '' | 'buy' | 'sell'; type: '' | 'market' | 'limit'; quantity: string; limitPrice: string;
}
export const emptyLiveAction = (): LiveActionDraft => ({ executorId: '', provider: '', symbol: '', side: '', type: '', quantity: '', limitPrice: '' });
export function draftFromLiveAction(action: LiveAction): LiveActionDraft {
  return { executorId: action.executorId, provider: action.market.provider === 'csv' ? '' : action.market.provider, symbol: action.market.symbol, side: action.side, type: action.type, quantity: action.quantity, limitPrice: action.limitPrice ?? '' };
}
export const canonicalDecimal = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
export const positiveDecimal = (value: string): boolean => canonicalDecimal.test(value) && /[1-9]/.test(value);
export function liveActionFromDraft(draft: LiveActionDraft): LiveAction {
  if (!draft.executorId || !draft.provider || !draft.symbol.trim() || !draft.side || !draft.type) throw new Error('Explicitly select executor, live venue, symbol, side, and order type.');
  if (!positiveDecimal(draft.quantity)) throw new Error('Quantity must be a positive canonical decimal string: use 1 or 0.01, not 1.0, leading zeros, or exponents.');
  if (draft.type === 'limit' && !positiveDecimal(draft.limitPrice)) throw new Error('Limit price must be a positive canonical decimal string.');
  const market: MarketRef = { provider: draft.provider, symbol: draft.symbol.trim() };
  return { executorId: draft.executorId, market, side: draft.side, type: draft.type, quantity: draft.quantity, ...(draft.type === 'limit' ? { limitPrice: draft.limitPrice } : {}) };
}
export function LiveActionFields({ id, draft, onChange, executors }: {
  id: string; draft: LiveActionDraft; onChange: (draft: LiveActionDraft) => void; executors: ExecutorRecord[];
}) {
  const registered = executors.filter((executor) => executor.archivedAt === null);
  return <div className="execution-form-grid">
    <div className="form-field"><label htmlFor={`${id}-executor`}>Registered external executor</label><select id={`${id}-executor`} required value={draft.executorId} onChange={(event) => onChange({ ...draft, executorId: event.target.value })}><option value="">Choose executor</option>{draft.executorId && !registered.some((row) => row.id === draft.executorId) && <option value={draft.executorId}>Unavailable existing executor · {draft.executorId}</option>}{registered.map((row) => <option key={row.id} value={row.id}>{row.name}{row.enabled ? '' : ' · disabled'}{row.claimsPausedReason ? ' · reconciliation required' : ''}</option>)}</select><small>Registration is not proof that an operator driver is connected.</small></div>
    <div className="form-field"><label htmlFor={`${id}-provider`}>Explicit live venue</label><select id={`${id}-provider`} required value={draft.provider} onChange={(event) => onChange({ ...draft, provider: event.target.value as LiveActionDraft['provider'], symbol: '' })}><option value="">Choose venue</option><option value="coinbase">Coinbase</option><option value="binance">Binance</option></select></div>
    <div className="form-field"><label htmlFor={`${id}-symbol`}>Exact venue symbol</label><input id={`${id}-symbol`} required maxLength={100} value={draft.symbol} onChange={(event) => onChange({ ...draft, symbol: event.target.value })} autoComplete="off" /><small>USD and USDT are different currencies. No conversion or venue substitution.</small></div>
    <div className="form-field"><label htmlFor={`${id}-side`}>Side</label><select id={`${id}-side`} required value={draft.side} onChange={(event) => onChange({ ...draft, side: event.target.value as LiveActionDraft['side'] })}><option value="">Choose side</option><option value="buy">Buy</option><option value="sell">Sell</option></select></div>
    <div className="form-field"><label htmlFor={`${id}-type`}>Order type</label><select id={`${id}-type`} required value={draft.type} onChange={(event) => onChange({ ...draft, type: event.target.value as LiveActionDraft['type'] })}><option value="">Choose type</option><option value="market">Market · price protected</option><option value="limit">Limit</option></select></div>
    <div className="form-field"><label htmlFor={`${id}-quantity`}>Quantity · canonical decimal</label><input id={`${id}-quantity`} required inputMode="decimal" value={draft.quantity} onChange={(event) => onChange({ ...draft, quantity: event.target.value })} autoComplete="off" /></div>
    {draft.type === 'limit' && <div className="form-field"><label htmlFor={`${id}-limit`}>Limit price · canonical decimal</label><input id={`${id}-limit`} required inputMode="decimal" value={draft.limitPrice} onChange={(event) => onChange({ ...draft, limitPrice: event.target.value })} autoComplete="off" /></div>}
  </div>;
}
