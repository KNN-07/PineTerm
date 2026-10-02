import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { API_KEY_SCOPES } from '@pineterm/contracts';
import type { ApiKey, ApiKeyScope, CreateApiKeyBody } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from './api.js';
import { Modal } from './Modal.js';
import { SettingsNavigation } from './features/alerts/SettingsNavigation.js';

const scopeDescriptions: Record<ApiKeyScope, string> = {
  'market:read': 'Read market data',
  'scripts:read': 'Read saved scripts',
  'backtests:run': 'Run strategy backtests',
  'paper:read': 'Read paper accounts',
  'paper:trade': 'Place and cancel paper orders',
  'live:intent': 'Request live executor handoff',
  'executor:claim': 'Claim intents for one executor',
  'executor:report': 'Report outcomes for one executor',
};

function formatTime(value: number | null): string {
  return value === null ? 'Never' : new Date(value).toLocaleString();
}

export function SecuritySettings({
  client,
  onClose,
  onSessionExpired,
  onOpenData,
  onOpenNotifications,
}: {
  client: ApiClient;
  onClose: () => void;
  onSessionExpired: () => void;
  onOpenData: () => void;
  onOpenNotifications: () => void;
}) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadVersion, setLoadVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>([]);
  const [executorId, setExecutorId] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tokenInput = useRef<HTMLTextAreaElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const requiresExecutor = scopes.some((scope) => scope.startsWith('executor:'));

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    client.listApiKeys(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setKeys(result.keys);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionExpired();
        else setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, loadVersion, onSessionExpired]);

  useEffect(() => {
    if (newToken) {
      tokenInput.current?.focus();
      tokenInput.current?.select();
    } else {
      nameInput.current?.focus();
    }
  }, [newToken]);

  function handleError(failure: unknown) {
    if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionExpired();
    else setError(errorMessage(failure));
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || newToken) return;
    setBusy('create');
    setError(null);
    setNotice(null);
    const body: CreateApiKeyBody = { name: name.trim(), scopes };
    if (requiresExecutor) body.executorId = executorId.trim();
    try {
      const result = await client.createApiKey(body);
      setKeys((current) => [result.key, ...current]);
      setNewToken(result.token);
      setCopyStatus(null);
      setName('');
      setScopes([]);
      setExecutorId('');
    } catch (failure) {
      handleError(failure);
    } finally {
      setBusy(null);
    }
  }

  async function revokeKey(key: ApiKey) {
    if (busy) return;
    if (!window.confirm(`Revoke “${key.name}”? Clients using this key will lose access immediately.`)) return;
    setBusy(key.id);
    setError(null);
    setNotice(null);
    try {
      await client.revokeApiKey(key.id);
      setNotice(`“${key.name}” has been revoked. Refresh keys if the list cannot update.`);
      const result = await client.listApiKeys();
      setKeys(result.keys);
    } catch (failure) {
      handleError(failure);
    } finally {
      setBusy(null);
    }
  }

  async function copyToken() {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopyStatus('Token copied. Store it securely; never commit it.');
    } catch {
      tokenInput.current?.focus();
      tokenInput.current?.select();
      setCopyStatus('Clipboard unavailable. Copy the selected token manually.');
    }
  }

  return (
    <Modal title="Security settings" titleId="security-title" onClose={onClose} closeDisabled={busy !== null}>
      <SettingsNavigation active="security" onData={onOpenData} onSecurity={() => {}} onNotifications={onOpenNotifications} disabled={busy !== null} />
      <p>API keys grant only their selected scopes. Keep tokens outside source control and browser storage.</p>
      <p className="muted">Only the signed-in administrator can create or revoke keys. A key cannot manage security settings or create other keys.</p>
      <p className="readiness-note">Market, saved-script, backtest, and live-paper routes accept their corresponding scopes. Alerts and notification configuration require an administrator session. Executor / live handoff services are not available yet; creating a scope does not enable them.</p>
      {error && <p className="message error" role="alert">{error}</p>}
      {notice && <p className="message" role="status">{notice}</p>}
      {newToken && (
        <section className="token-panel" aria-labelledby="token-title">
          <h3 id="token-title">Save your new token now</h3>
          <p>This is its only display. Closing Settings clears it from this view. The server stores only its hash.</p>
          <label htmlFor="new-key-token">New API token</label>
          <textarea id="new-key-token" ref={tokenInput} value={newToken} readOnly rows={3} spellCheck={false} autoComplete="off" />
          <div className="actions">
            <button type="button" onClick={() => void copyToken()}>Copy token</button>
            <button type="button" onClick={() => {
              setNewToken(null);
              setCopyStatus(null);
            }}>I have saved this token</button>
          </div>
          {copyStatus && <p role="status">{copyStatus}</p>}
        </section>
      )}
      <section aria-labelledby="new-key-title">
        <h3 id="new-key-title">Create a scoped key</h3>
        <form onSubmit={(event) => void createKey(event)}>
          <fieldset disabled={busy !== null || newToken !== null || loading}>
            <div className="form-field">
              <label htmlFor="key-name">Key name</label>
              <input id="key-name" ref={nameInput} value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} autoComplete="off" placeholder="For example, local read-only client" />
            </div>
            <fieldset className="scope-list">
              <legend>Scopes — select only what your client needs</legend>
              {API_KEY_SCOPES.map((scope) => (
                <label key={scope} className="scope-option">
                  <input type="checkbox" checked={scopes.includes(scope)} onChange={(event) => {
                    setScopes((current) => event.target.checked ? [...current, scope] : current.filter((value) => value !== scope));
                  }} />
                  <span><code>{scope}</code><span className="muted scope-description">{scopeDescriptions[scope]}</span></span>
                </label>
              ))}
            </fieldset>
            {requiresExecutor && (
              <div className="form-field">
                <label htmlFor="executor-id">Executor ID</label>
                <input id="executor-id" value={executorId} onChange={(event) => setExecutorId(event.target.value)} required autoComplete="off" aria-describedby="executor-help" />
                <p id="executor-help" className="muted">Executor scopes must be bound to one executor ID. No executor service is implemented in this milestone.</p>
              </div>
            )}
            <button type="submit" className="primary" disabled={name.trim().length === 0 || scopes.length === 0 || (requiresExecutor && executorId.trim().length === 0)}>
              {busy === 'create' ? 'Creating…' : 'Create key'}
            </button>
          </fieldset>
        </form>
      </section>
      <section aria-labelledby="keys-title" aria-busy={loading}>
        <div className="section-heading">
          <h3 id="keys-title">Existing keys</h3>
          <button type="button" disabled={busy !== null || loading} onClick={() => setLoadVersion((value) => value + 1)}>Refresh keys</button>
        </div>
        {loading ? <p role="status">Loading keys…</p> : keys.length === 0 ? <p>No API keys to display.</p> : (
          <ul className="key-list">
            {keys.map((key) => (
              <li key={key.id} className="key-card">
                <div className="section-heading">
                  <strong>{key.name}</strong>
                  <span className={key.revokedAt === null ? 'status' : 'muted'}>{key.revokedAt === null ? 'Active' : 'Revoked'}</span>
                </div>
                <p className="scope-summary">{key.scopes.map((scope) => <code key={scope}>{scope}</code>)}</p>
                {key.executorId && <p>Executor: <code>{key.executorId}</code></p>}
                <dl className="key-details">
                  <div><dt>Created</dt><dd>{formatTime(key.createdAt)}</dd></div>
                  <div><dt>Last used</dt><dd>{formatTime(key.lastUsedAt)}</dd></div>
                  {key.revokedAt !== null && <div><dt>Revoked</dt><dd>{formatTime(key.revokedAt)}</dd></div>}
                </dl>
                {key.revokedAt === null && <button type="button" className="danger" disabled={busy !== null} onClick={() => void revokeKey(key)}>{busy === key.id ? 'Revoking…' : 'Revoke key'}</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Modal>
  );
}
