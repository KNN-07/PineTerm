import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { About, SOURCE_URL } from './About.js';
import { ApiClient, ApiError, errorMessage } from './api.js';
import { SecuritySettings } from './SecuritySettings.js';

type SessionState = 'checking' | 'signed-out' | 'signed-in' | 'unavailable';

export function App() {
  const [client] = useState(() => new ApiClient());
  const [sessionState, setSessionState] = useState<SessionState>('checking');
  const [checkVersion, setCheckVersion] = useState(0);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'security' | 'about' | null>(null);
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
      if (failure instanceof ApiError && failure.status === 401) onSessionExpired();
      else setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function closePanel() {
    const previous = panel;
    setPanel(null);
    if (previous === 'security') settingsButton.current?.focus();
    else aboutButton.current?.focus();
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">P</span>
          <strong>PineTerm</strong>
          <span className="milestone-label">Milestone 2</span>
        </div>
        <nav aria-label="Application">
          {sessionState === 'signed-in' && <button type="button" ref={settingsButton} onClick={() => setPanel('security')}>Settings</button>}
          <button type="button" ref={aboutButton} onClick={() => setPanel('about')}>About</button>
          <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">Source</a>
          {sessionState === 'signed-in' && <button type="button" onClick={() => void logout()} disabled={busy}>{busy ? 'Signing out…' : 'Sign out'}</button>}
        </nav>
      </header>
      <main id="main-content" tabIndex={-1}>
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
        {sessionState === 'signed-in' && (
          <div className="workspace-foundation">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Administrator workspace</p>
                <h1>Your PineTerm foundation is ready</h1>
              </div>
              <span className="status">Signed in</span>
            </div>
            {error && <p className="message error" role="alert">{error}</p>}
            <section className="foundation-panel" aria-labelledby="readiness-title">
              <h2 id="readiness-title">A running shell, not a simulated terminal</h2>
              <p>Administrator sessions, scoped API keys and authoritative Binance/Coinbase market services are available. Historical CSV import/export is supported by the API. Chart UI is the next milestone; no live execution is enabled.</p>
              <button type="button" className="primary" onClick={() => setPanel('security')}>Manage API keys</button>
            </section>
            <section aria-labelledby="capabilities-title">
              <h2 id="capabilities-title">Capability readiness</h2>
              <dl className="readiness-list">
                <div><dt>Login and security settings</dt><dd><span className="status">Available now</span> · single administrator, session protection and scoped keys</dd></div>
                <div><dt>Real market data</dt><dd><span className="status">Available via API</span> · Binance Spot, Coinbase Exchange, confirmed-bar streams and historical CSV datasets</dd></div>
                <div><dt>Charts and workspaces</dt><dd>Not implemented · Vela charts, drawings and saved layouts are planned for milestone 3</dd></div>
                <div><dt>Pine and strategy testing</dt><dd>Not implemented · PineTS indicators and isolated backtests are planned for milestone 4</dd></div>
                <div><dt>Paper trading and replay</dt><dd>Not implemented · server-authoritative paper accounts are planned for milestone 5</dd></div>
                <div><dt>Alerts and notifications</dt><dd>Not implemented · durable webhooks and Telegram are planned for milestone 6</dd></div>
                <div><dt>External executor handoff</dt><dd>Not implemented · opt-in, scoped execution protocol is planned for milestone 7</dd></div>
                <div><dt>Pi analysis and Pine authoring</dt><dd>Not implemented · restricted analysis tools are planned for milestone 8</dd></div>
              </dl>
            </section>
          </div>
        )}
      </main>
      <footer className="app-footer">
        <span>PineTerm · AGPL-3.0-only</span>
        <span>Chart technology: <a href="https://velacharts.dev" target="_blank" rel="noopener noreferrer">Vela by LuxAlgo</a> · not yet mounted</span>
        <span>Market API available · trading disabled</span>
      </footer>
      {panel === 'security' && sessionState === 'signed-in' && <SecuritySettings client={client} onClose={closePanel} onSessionExpired={onSessionExpired} />}
      {panel === 'about' && <About client={client} onClose={closePanel} />}
    </div>
  );
}
