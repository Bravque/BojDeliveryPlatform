import { useState } from 'react';
import type { ApiClient, Period } from './api';
import { OverviewView } from './overview';
import { AuditView } from './audit';
import { MerchantsView } from './merchants';
import { RidersView } from './riders';
import { SettlementsView } from './settlements';
import { PayoutsView } from './payouts';
import { RefundsView } from './refunds';
import { ConfigView } from './config';
import { Brand, Button, Field } from './ui';

export interface AppProps {
  api: ApiClient;
  /** Initial reporting window for the overview; defaults to the last 30 days. Injectable for tests. */
  initialPeriod?: Period;
}

/** Last 30 days, ending today, as YYYY-MM-DD. */
export function defaultPeriod(now: Date = new Date()): Period {
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  return { periodStart: start, periodEnd: end };
}

type View =
  'overview' | 'merchants' | 'riders' | 'settlements' | 'payouts' | 'refunds' | 'config' | 'audit';

const NAV: { key: View; label: string; icon: string }[] = [
  { key: 'overview', label: 'Overview', icon: '📊' },
  { key: 'merchants', label: 'Merchants', icon: '🏪' },
  { key: 'riders', label: 'Riders', icon: '🛵' },
  { key: 'settlements', label: 'Settlements', icon: '🧾' },
  { key: 'payouts', label: 'Payouts', icon: '💸' },
  { key: 'refunds', label: 'Refunds', icon: '↩️' },
  { key: 'config', label: 'Config', icon: '⚙️' },
  { key: 'audit', label: 'Audit', icon: '🔎' },
];

/**
 * Admin console shell. The access token is held in memory only (a reload returns to the login form —
 * a deliberate choice for a sensitive back-office console, no localStorage). Sections render their
 * own data from REST; those not yet built show a placeholder until their increment lands.
 */
export function App({ api, initialPeriod }: AppProps): JSX.Element {
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View>('overview');
  const [loginError, setLoginError] = useState<string | null>(null);

  const period = initialPeriod ?? defaultPeriod();

  async function onLogin(email: string, password: string): Promise<void> {
    setLoginError(null);
    try {
      const { access } = await api.login(email, password);
      setToken(access);
    } catch {
      setLoginError('Login failed. Check your email and password.');
    }
  }

  function onLogout(): void {
    setToken(null);
    setView('overview');
  }

  if (!token) {
    return <LoginForm onLogin={onLogin} error={loginError} />;
  }

  const active = NAV.find((n) => n.key === view)!;

  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <nav className="nav" aria-label="Sections">
          {NAV.map((n) => (
            <button
              key={n.key}
              type="button"
              className={`nav__item${view === n.key ? ' nav__item--active' : ''}`}
              aria-current={view === n.key ? 'page' : undefined}
              onClick={() => setView(n.key)}
            >
              <span className="nav__icon">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <h1 className="topbar__title">{active.label}</h1>
          <div className="topbar__spacer" />
          <Button variant="ghost" small onClick={onLogout}>
            Log out
          </Button>
        </header>

        <main className="content">
          {view === 'overview' && <OverviewView api={api} token={token} initialPeriod={period} />}
          {view === 'merchants' && <MerchantsView api={api} token={token} />}
          {view === 'riders' && <RidersView api={api} token={token} />}
          {view === 'settlements' && <SettlementsView api={api} token={token} />}
          {view === 'payouts' && <PayoutsView api={api} token={token} />}
          {view === 'refunds' && <RefundsView api={api} token={token} />}
          {view === 'config' && <ConfigView api={api} token={token} />}
          {view === 'audit' && <AuditView api={api} token={token} />}
        </main>
      </div>
    </div>
  );
}

function LoginForm({
  onLogin,
  error,
}: {
  onLogin: (email: string, password: string) => void;
  error: string | null;
}): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <div className="login">
      <form
        className="login__card"
        onSubmit={(e) => {
          e.preventDefault();
          onLogin(email, password);
        }}
      >
        <Brand />
        <h1 className="login__title">Admin sign in</h1>
        <p className="login__sub">Operations, finance and platform configuration.</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Field label="Email" type="email" value={email} onChange={setEmail} autoFocus />
        <Field label="Password" type="password" value={password} onChange={setPassword} />
        <Button variant="primary" block type="submit">
          Sign in
        </Button>
      </form>
    </div>
  );
}
