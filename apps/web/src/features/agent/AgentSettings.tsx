import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AgentConfig, AgentModelChoice, AgentStatus, UpdateAgentConfig } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import { Modal } from '../../Modal.js';
import { SettingsNavigation } from '../alerts/SettingsNavigation.js';
import './agent.css';

export function AgentSettings({ client, onClose, onSessionExpired, onOpenData, onOpenSecurity, onOpenNotifications, onOpenExecution, onChanged }: {
  client: ApiClient; onClose: () => void; onSessionExpired: () => void; onOpenData: () => void; onOpenSecurity: () => void; onOpenNotifications: () => void; onOpenExecution: () => void; onChanged: () => void;
}) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [models, setModels] = useState<AgentModelChoice[]>([]);
  const [provider, setProvider] = useState(''); const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState(''); const [baseUrl, setBaseUrl] = useState('');
  const [authMode, setAuthMode] = useState<'api-key' | 'none'>('api-key');
  const [contextWindow, setContextWindow] = useState(''); const [maxTokens, setMaxTokens] = useState('');
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const fail = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionExpired();
    setError(errorMessage(failure));
  }, [onSessionExpired]);
  const restore = useCallback((value: AgentConfig) => {
    setConfig(value); setProvider(value.provider ?? ''); setModel(value.model ?? ''); setBaseUrl(value.baseUrl ?? ''); setAuthMode(value.authMode);
    setContextWindow(value.contextWindow === null ? '' : String(value.contextWindow)); setMaxTokens(value.maxTokens === null ? '' : String(value.maxTokens)); setApiKey('');
  }, []);
  const load = useCallback(async (signal: AbortSignal) => {
    const [value, state, catalog] = await Promise.all([client.request<AgentConfig>('/agent/config', { signal }), client.request<AgentStatus>('/agent/status', { signal }), client.request<{ models: AgentModelChoice[] }>('/agent/models', { signal })]);
    if (!signal.aborted) { restore(value); setStatus(state); setModels(catalog.models); }
  }, [client, restore]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(failure => { if (!controller.signal.aborted) fail(failure); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); operation.current?.abort(); };
  }, [load, fail]);

  const catalogChoice = models.find(choice => choice.provider === provider.trim() && choice.id === model.trim());

  async function command(kind: 'save' | 'delete' | 'reload', event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (busy || (kind !== 'reload' && !config)) return;
    if (kind === 'delete' && !window.confirm('Remove the encrypted model configuration? Saved conversations and Pine drafts remain available.')) return;
    const enteredKey = apiKey; setApiKey(''); setBusy(true); setError(null); setNotice(null);
    const controller = new AbortController(); operation.current = controller;
    try {
      if (kind === 'save') {
        const body: UpdateAgentConfig = { revision: config!.revision, provider: provider.trim(), model: model.trim(), authMode, baseUrl: baseUrl.trim() || null, ...(authMode === 'api-key' && enteredKey ? { apiKey: enteredKey } : {}) };
        if (baseUrl.trim()) {
          const url = new URL(baseUrl.trim());
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('Use an HTTP(S) model base URL without credentials, query parameters or fragments. The server enforces local-host restrictions.');
        }
        if (!catalogChoice) for (const [key, value] of [['contextWindow', contextWindow], ['maxTokens', maxTokens]] as const) {
          if (value.trim()) { const number = Number(value); if (!Number.isSafeInteger(number) || number <= 0 || number > 2_000_000) throw new Error(`${key} must be a positive whole number of tokens, up to 2,000,000.`); body[key] = number; }
        }
        if (body.contextWindow && body.maxTokens && body.maxTokens > body.contextWindow) throw new Error('Maximum output tokens must not exceed the context window.');
        const value = await client.request<AgentConfig>('/agent/config', { method: 'PUT', csrf: true, body, signal: controller.signal });
        if (!controller.signal.aborted) restore(value);
      } else if (kind === 'delete') await client.request<void>('/agent/config', { method: 'DELETE', csrf: true, signal: controller.signal });
      await load(controller.signal);
      if (!controller.signal.aborted) { onChanged(); setNotice(kind === 'save' ? 'Configuration saved. Availability below is the server status, not a credentialed model smoke.' : kind === 'delete' ? 'Model configuration removed. No model prompt can run.' : 'Saved configuration reloaded.'); }
    } catch (failure) { if (!controller.signal.aborted) fail(failure); }
    finally { if (!controller.signal.aborted) setBusy(false); operation.current = null; }
  }
  const choices = models.filter(choice => choice.provider === provider);
  return <Modal title="Settings · Pi model" titleId="agent-settings-title" onClose={() => { setApiKey(''); onClose(); }} closeDisabled={busy}>
    <div className="agent-settings">
      <SettingsNavigation active="agent" onData={onOpenData} onSecurity={onOpenSecurity} onNotifications={onOpenNotifications} onExecution={onOpenExecution} onAgent={() => {}} disabled={busy} />
      <p>Analysis and Pine drafts only. Model credentials are write-only and encrypted by the server; no browser storage, environment-key discovery or default model. Entered keys clear when a request starts or these settings close.</p>
      {loading && <p role="status">Loading protected server configuration…</p>}
      {error && <p className="message error" role="alert">{error}<small>Conflicts require reloading and reviewing the saved configuration; there is no force overwrite.</small></p>}
      {notice && <p role="status">{notice}</p>}
      <div className="agent-boundary" role="status"><strong>{status ? status.available ? 'Model configured · ready for a prompt' : 'Model unavailable' : 'Availability not yet known'}</strong><span>{status?.reason ?? (status ? `${status.provider} / ${status.model}` : 'Checking the server…')}</span></div>
      <form onSubmit={event => void command('save', event)} autoComplete="off">
        <fieldset disabled={loading || busy || !config}>
          <div className="agent-config-grid">
            <label>Provider<input list="agent-provider-catalog" value={provider} onChange={event => { setProvider(event.target.value); setModel(''); setContextWindow(''); setMaxTokens(''); setApiKey(''); }} required maxLength={64} placeholder="Choose a provider or local adapter" /></label>
            <datalist id="agent-provider-catalog">{[...new Set(models.map(choice => choice.provider))].map(id => <option key={id} value={id} />)}</datalist>
            <label>Model<input list="agent-model-catalog" value={model} onChange={event => setModel(event.target.value)} required maxLength={200} placeholder="Explicit model ID" /></label>
            <datalist id="agent-model-catalog">{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name} · context {choice.contextWindow} · output {choice.maxTokens}</option>)}</datalist>
            <label>Authentication<select value={authMode} onChange={event => { setAuthMode(event.target.value as typeof authMode); setApiKey(''); }}><option value="api-key">API key</option><option value="none">No authentication · explicit local model only</option></select></label>
            {authMode === 'api-key' && <label>Write-only API key<input type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} maxLength={8192} placeholder={config?.apiKeyConfigured ? 'Saved key · leave blank to retain' : 'Enter securely here, not in chat'} /></label>}
            <label>Optional local base URL<input type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} maxLength={2048} placeholder="http://127.0.0.1:11434/v1" required={authMode === 'none'} /></label>
          </div>
          <details open={!!baseUrl && !catalogChoice}><summary>Local model token metadata</summary><p className="muted">{catalogChoice ? `Pinned catalog capacity: ${catalogChoice.contextWindow} context tokens / ${catalogChoice.maxTokens} output tokens. These cannot be overridden.` : 'For an unknown local model, supply its actual server-supported context window and output limit (up to 2,000,000).'} These are capacity limits, not known billing rates. No-auth requires an administrator-approved local/private-address HTTP(S) base URL; custom cloud URLs cannot use no-auth or replace pinned cloud endpoints.</p><div className="agent-config-grid"><label>Context window · tokens<input type="number" min="1" max="2000000" step="1" value={catalogChoice ? catalogChoice.contextWindow : contextWindow} disabled={!!catalogChoice} onChange={event => setContextWindow(event.target.value)} /></label><label>Maximum output · tokens<input type="number" min="1" max="2000000" step="1" value={catalogChoice ? catalogChoice.maxTokens : maxTokens} disabled={!!catalogChoice} onChange={event => setMaxTokens(event.target.value)} /></label></div></details>
          <div className="compact-actions"><button type="submit" className="primary" disabled={!provider.trim() || !model.trim()}>Save model configuration</button><button type="button" className="danger" disabled={!config?.configured} onClick={() => void command('delete')}>Remove configuration</button></div>
        </fieldset>
      </form>
      <button type="button" disabled={busy} onClick={() => void command('reload')}>Reload saved configuration / status</button>
      <p className="muted">Model replies, script comments and feed content are untrusted. Pi cannot buy, sell, arm an alert, enable execution policy, access integration secrets, or register tools. A real streamed-model acceptance requires your selected model and credentials.</p>
    </div>
  </Modal>;
}
