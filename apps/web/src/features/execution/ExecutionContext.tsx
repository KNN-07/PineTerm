import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ExecutionPolicy, ExecutorRecord, InvalidationEvent, LiveIntent, ReportedPosition, RiskUsage, UpdateExecutionPolicy } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import './execution.css';

interface ExecutionState {
  client: ApiClient; policy: ExecutionPolicy | null; executors: ExecutorRecord[]; intents: LiveIntent[];
  usage: RiskUsage[]; positions: ReportedPosition[]; loading: boolean; error: string | null;
  policyBusy: boolean; notice: string | null; refresh: () => void;
  savePolicy: (body: UpdateExecutionPolicy) => Promise<ExecutionPolicy>; kill: () => Promise<void>;
}
const Context = createContext<ExecutionState | null>(null);
export function useExecution(): ExecutionState {
  const state = useContext(Context);
  if (!state) throw new Error('Execution UI requires its authenticated provider.');
  return state;
}
export function ExecutionProvider({ client, enabled, onSessionExpired, children }: {
  client: ApiClient; enabled: boolean; onSessionExpired: () => void; children: ReactNode;
}) {
  const [policy, setPolicy] = useState<ExecutionPolicy | null>(null);
  const [executors, setExecutors] = useState<ExecutorRecord[]>([]);
  const [intents, setIntents] = useState<LiveIntent[]>([]);
  const [usage, setUsage] = useState<RiskUsage[]>([]);
  const [positions, setPositions] = useState<ReportedPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [policyBusy, setPolicyBusy] = useState(false);
  const policyOperation = useRef(false);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const fail = useCallback((failure: unknown) => {
    setError(errorMessage(failure));
    if (failure instanceof ApiError && failure.status === 401) onSessionExpired();
  }, [onSessionExpired]);
  useEffect(() => {
    if (!enabled) {
      setPolicy(null); setExecutors([]); setIntents([]); setUsage([]); setPositions([]); setError(null); setNotice(null);
      return;
    }
    const controller = new AbortController(); setLoading(true);
    void Promise.all([
      client.request<ExecutionPolicy>('/execution-policy', { signal: controller.signal }).then((next) => {
        if (!controller.signal.aborted) setPolicy((current) => current && current.revision > next.revision ? current : next);
        return next;
      }),
      client.request<{ executors: ExecutorRecord[] }>('/executors', { signal: controller.signal }),
      client.request<{ intents: LiveIntent[] }>('/order-intents', { signal: controller.signal }),
      client.request<{ usage: RiskUsage[] }>('/execution-risk', { signal: controller.signal }),
      client.request<{ positions: ReportedPosition[] }>('/reported-positions', { signal: controller.signal }),
    ]).then(([nextPolicy, registered, history, risk, reported]) => {
      if (controller.signal.aborted) return;
      setPolicy((current) => current && current.revision > nextPolicy.revision ? current : nextPolicy); setExecutors(registered.executors); setIntents(history.intents); setUsage(risk.usage); setPositions(reported.positions); setError(null);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) fail(failure); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, enabled, version, fail]);
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource('/api/v1/events');
    source.onopen = refresh;
    source.onerror = () => setError('Execution event stream disconnected. Last observed state is retained; refresh before creating handoffs.');
    source.addEventListener('invalidation', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as InvalidationEvent;
        if (data.type === 'live-intents.changed') refresh();
      } catch { setError('Execution event stream was unreadable. Refresh authoritative state.'); }
    });
    return () => source.close();
  }, [enabled, refresh]);
  const savePolicy = useCallback(async (body: UpdateExecutionPolicy) => {
    if (!enabled || policyOperation.current) throw new Error('Another policy change is already in progress.');
    policyOperation.current = true; setPolicyBusy(true); setNotice(null);
    try {
      const next = await client.request<ExecutionPolicy>('/execution-policy', { method: 'PUT', csrf: true, body });
      setPolicy(next); refresh(); return next;
    } catch (failure) { fail(failure); throw failure; }
    finally { policyOperation.current = false; setPolicyBusy(false); }
  }, [client, enabled, fail, refresh]);
  const kill = useCallback(async () => {
    if (!enabled || policyOperation.current) return;
    policyOperation.current = true; setPolicyBusy(true); setNotice(null);
    try {
      const current = await client.request<ExecutionPolicy>('/execution-policy');
      const next = await client.request<ExecutionPolicy>('/execution-policy', { method: 'PUT', csrf: true, body: { enabled: false, revision: current.revision } });
      setPolicy(next); setNotice('Handoff disabled. Unclaimed intents are cancelled; externally accepted or ambiguous orders only receive cancellation requests. Venue cancellation is NOT guaranteed.'); refresh();
    } catch (failure) { fail(failure); }
    finally { policyOperation.current = false; setPolicyBusy(false); }
  }, [client, enabled, fail, refresh]);
  return <Context.Provider value={{ client, policy, executors, intents, usage, positions, loading, error, policyBusy, notice, refresh, savePolicy, kill }}>{children}</Context.Provider>;
}

export function ExecutionStatus({ onOpenExecution, compact = false }: { onOpenExecution?: () => void; compact?: boolean }) {
  const { policy, loading, error, policyBusy, kill, notice } = useExecution();
  const label = policy?.enabled ? 'LIVE HANDOFF ENABLED' : error ? 'Handoff state unavailable' : !policy ? 'Checking handoff…' : 'Live handoff disabled';
  return <div className={`execution-status ${policy?.enabled ? 'is-live' : ''} ${compact ? 'is-compact' : ''}`}>
    {onOpenExecution ? <button type="button" className="execution-state-label" onClick={onOpenExecution} title={error ?? notice ?? 'External execution settings'}>{label}{policy && error ? ' · stale' : ''}</button> : <strong className="execution-state-label" role="status">{label}{policy && error ? ' · stale' : ''}</strong>}
    {(policy?.enabled || error) && <button type="button" className="danger" disabled={policyBusy} onClick={() => void kill()} title="Disable new handoffs and request cancellation. Venue cancellation cannot be guaranteed.">{policyBusy ? 'Disabling…' : 'Kill handoff'}</button>}
    {compact && (policy?.enabled || notice) && <small className="execution-cancel-warning" role="status">{policy?.enabled ? 'Kill requests cancellation · venue cancellation NOT guaranteed' : 'Handoff disabled · venue cancellation NOT guaranteed'}</small>}
    {!compact && <><p className="muted">This is a pull handoff, not direct exchange trading. Disabling requests cancellation but cannot guarantee venue cancellation.</p>{loading && <small>Refreshing authoritative execution state…</small>}{error && <p className="message error" role="alert">{error}</p>}{notice && <p className="message" role="status">{notice}</p>}</>}
  </div>;
}
