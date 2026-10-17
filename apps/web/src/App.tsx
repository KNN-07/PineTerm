import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { About, SOURCE_URL } from './About.js';
import { ApiClient, ApiError, errorMessage } from './api.js';
import { SecuritySettings } from './SecuritySettings.js';
import { Terminal } from './features/workspace/Terminal.js';
import { IntegrationSettings } from './features/alerts/IntegrationSettings.js';
import { ExecutionProvider } from './features/execution/ExecutionContext.js';
import { ExecutionSettings } from './features/execution/ExecutionSettings.js';
import { AgentSettings } from './features/agent/AgentSettings.js';

type SessionState = 'checking' | 'signed-out' | 'signed-in' | 'unavailable';

export function App() {
  const [client] = useState(() => new ApiClient());
  const [sessionState, setSessionState] = useState<SessionState>('checking');
  const [, setConnection] = useState('Feed connecting');
  const [checkVersion, setCheckVersion] = useState(0);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'data' | 'security' | 'notifications' | 'execution' | 'agent' | 'about' | null>(null);
  const [agentConfigVersion, setAgentConfigVersion] = useState(0);
  const loginInput = useRef<HTMLInputElement>(null);
  const panelOpener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setSessionState('checking');
    setError(null);
    client.getSession(controller.signal)
      .then((session) => {
        if (!controller.signal.aborted) setSessionState(session ? 'signed-in' : 'signed-out');
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(failure));
        setSessionState('unavailable');
      });
    return () => controller.abort();
  }, [client, checkVersion]);

  useEffect(() => {
    if (!busy && sessionState === 'signed-out') loginInput.current?.focus();
  }, [busy, sessionState]);

  const onSessionExpired = useCallback(() => {
    setPanel(null);
    setPassword('');
    setSessionState('signed-out');
    setError('Your session has expired. Sign in again to continue.');
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.login(password);
      setSessionState('signed-in');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPassword('');
      setBusy(false);
    }
  }

  async function logout() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.logout();
      setPanel(null);
      setPassword('');
      setSessionState('signed-out');
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionExpired();
      else setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  /** Settings dialogs chain into each other; focus returns to whatever opened the first one. */
  function openPanel(next: NonNullable<typeof panel>) {
    if (!panel) panelOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanel(next);
  }
  function closePanel() {
    setPanel(null);
    const opener = panelOpener.current;
    panelOpener.current = null;
    if (opener?.isConnected) opener.focus();
  }

  return (
    <ExecutionProvider client={client} enabled={sessionState === 'signed-in'} onSessionExpired={onSessionExpired}>
    <div className={`app-shell ${sessionState === 'signed-in' ? 'signed-in-shell' : ''}`}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      {sessionState !== 'signed-in' && <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">P</span>
          <strong>PineTerm</strong>
          <span className="milestone-label" role="status">Self-hosted terminal</span>
        </div>
        <nav aria-label="Application">
          <button type="button" className="ghost" onClick={() => openPanel('about')}>About</button>
          <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">Source</a>
        </nav>
      </header>}
      {sessionState === 'signed-in' && error && <div className="terminal-notice error app-notice" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
      <main id="main-content" tabIndex={-1} className={sessionState === 'signed-in' ? 'terminal-main' : ''}>
        {sessionState === 'checking' && (
          <section className="login-card" aria-busy="true"><h1>PineTerm</h1><p role="status">Checking your administrator session…</p></section>
        )}
        {sessionState === 'unavailable' && (
          <section className="login-card">
            <h1>Server unavailable</h1>
            <p className="message error" role="alert">{error}</p>
            <p>No session could be checked. Your data has not been changed.</p>
            <button type="button" className="primary" onClick={() => setCheckVersion((value) => value + 1)}>Retry connection</button>
          </section>
        )}
        {sessionState === 'signed-out' && (
          <section className="login-card" aria-labelledby="login-title">
            <span className="login-mark" aria-hidden="true">P</span>
            <h1 id="login-title">Sign in to PineTerm</h1>
            <p className="muted">Your charting and strategy workspace starts here. Sign in with the administrator password configured on your server.</p>
            {error && <p className="message error" role="alert">{error}</p>}
            <form onSubmit={(event) => void login(event)}>
              <div className="form-field">
                <label htmlFor="admin-password">Administrator password</label>
                <input id="admin-password" ref={loginInput} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required disabled={busy} aria-describedby="password-help" />
              </div>
              <button type="submit" className="primary" disabled={busy || password.length === 0}>{busy ? 'Signing in…' : 'Sign in'}</button>
              <p id="password-help" className="muted">No registration or default password. Your deployment supplies <code>PINETERM_ADMIN_PASSWORD</code>.</p>
            </form>
          </section>
        )}
        {sessionState === 'signed-in' && <Terminal client={client} onSessionExpired={onSessionExpired} onConnection={setConnection} settingsOpen={panel === 'data'} onCloseSettings={closePanel} onOpenSettings={() => openPanel('data')} onOpenSecurity={() => openPanel('security')} onOpenNotifications={() => openPanel('notifications')} onOpenExecution={() => openPanel('execution')} onOpenAgent={() => openPanel('agent')} onOpenAbout={() => openPanel('about')} onSignOut={() => void logout()} signingOut={busy} agentConfigVersion={agentConfigVersion} />}
      </main>
      {sessionState !== 'signed-in' && <footer className="app-footer">
        <span>PineTerm · AGPL-3.0-only</span>
        <span>Charts by <a href="https://velacharts.dev" target="_blank" rel="noopener noreferrer">Vela by LuxAlgo</a></span>
        <span>Venue-qualified data · operator-driven external execution</span>
      </footer>}
      {panel === 'security' && sessionState === 'signed-in' && <SecuritySettings client={client} onClose={closePanel} onSessionExpired={onSessionExpired} onOpenData={() => openPanel('data')} onOpenNotifications={() => openPanel('notifications')} onOpenExecution={() => openPanel('execution')} onOpenAgent={() => openPanel('agent')} />}
      {panel === 'notifications' && sessionState === 'signed-in' && <IntegrationSettings client={client} onClose={closePanel} onSessionExpired={onSessionExpired} onOpenData={() => openPanel('data')} onOpenSecurity={() => openPanel('security')} onOpenExecution={() => openPanel('execution')} onOpenAgent={() => openPanel('agent')} />}
      {panel === 'execution' && sessionState === 'signed-in' && <ExecutionSettings onClose={closePanel} onOpenData={() => openPanel('data')} onOpenSecurity={() => openPanel('security')} onOpenNotifications={() => openPanel('notifications')} onOpenAgent={() => openPanel('agent')} />}
      {panel === 'agent' && sessionState === 'signed-in' && <AgentSettings client={client} onClose={closePanel} onSessionExpired={onSessionExpired} onOpenData={() => openPanel('data')} onOpenSecurity={() => openPanel('security')} onOpenNotifications={() => openPanel('notifications')} onOpenExecution={() => openPanel('execution')} onChanged={() => setAgentConfigVersion(value => value + 1)} />}
      {panel === 'about' && <About client={client} onClose={closePanel} />}
    </div>
    </ExecutionProvider>
  );
}
