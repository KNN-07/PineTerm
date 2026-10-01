import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { About, SOURCE_URL } from './About.js';
import { ApiClient, ApiError, errorMessage } from './api.js';
import { SecuritySettings } from './SecuritySettings.js';
import { Terminal } from './features/workspace/Terminal.js';

type SessionState = 'checking' | 'signed-out' | 'signed-in' | 'unavailable';

export function App() {
  const [client] = useState(() => new ApiClient());
  const [sessionState, setSessionState] = useState<SessionState>('checking');
  const [connection, setConnection] = useState('Feed connecting');
  const [checkVersion, setCheckVersion] = useState(0);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'data' | 'security' | 'about' | null>(null);
  const loginInput = useRef<HTMLInputElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const aboutButton = useRef<HTMLButtonElement>(null);

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
    if (busy) return;
    if (sessionState === 'signed-out') loginInput.current?.focus();
    else if (sessionState === 'signed-in') settingsButton.current?.focus();
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

  function closePanel() {
    const previous = panel;
    setPanel(null);
    if (previous === 'security' || previous === 'data') settingsButton.current?.focus();
    else aboutButton.current?.focus();
  }

  return (
    <div className={`app-shell ${sessionState === 'signed-in' ? 'signed-in-shell' : ''}`}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">P</span>
          <strong>PineTerm</strong>
          <span className="milestone-label" role="status">{sessionState === 'signed-in' ? connection : 'Self-hosted terminal'}</span>
        </div>
        <nav aria-label="Application">
          {sessionState === 'signed-in' && <button type="button" ref={settingsButton} onClick={() => setPanel('data')}>Settings</button>}
          <button type="button" ref={aboutButton} onClick={() => setPanel('about')}>About</button>
          <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">Source</a>
          {sessionState === 'signed-in' && <button type="button" onClick={() => void logout()} disabled={busy}>{busy ? 'Signing out…' : 'Sign out'}</button>}
        </nav>
      </header>
      {sessionState === 'signed-in' && error && <div className="terminal-notice error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
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
            <p className="eyebrow">Single-user · self-hosted</p>
            <h1 id="login-title">Welcome to PineTerm</h1>
            <p>Your charting and strategy workspace starts here. Sign in with the administrator password configured on your server.</p>
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
        {sessionState === 'signed-in' && <Terminal client={client} onSessionExpired={onSessionExpired} onConnection={setConnection} settingsOpen={panel === 'data'} onCloseSettings={closePanel} onOpenSecurity={() => setPanel('security')} />}
      </main>
      <footer className="app-footer">
        <span>PineTerm · AGPL-3.0-only</span>
        <span>Charts by <a href="https://velacharts.dev" target="_blank" rel="noopener noreferrer">Vela by LuxAlgo</a></span>
        <span>Venue-qualified data · live handoff disabled</span>
      </footer>
      {panel === 'security' && sessionState === 'signed-in' && <SecuritySettings client={client} onClose={closePanel} onSessionExpired={onSessionExpired} />}
      {panel === 'about' && <About client={client} onClose={closePanel} />}
    </div>
  );
}
