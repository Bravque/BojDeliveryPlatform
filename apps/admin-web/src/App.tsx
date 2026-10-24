import { useCallback, useState } from 'react';
import type { ApiClient, Period, ReconciliationReport, ReportSummary } from './api';

export interface AppProps {
  api: ApiClient;
  /** Initial reporting window; defaults to the last 30 days. Injectable for deterministic tests. */
  initialPeriod?: Period;
}

/** Last 30 days, ending today, as YYYY-MM-DD. */
export function defaultPeriod(now: Date = new Date()): Period {
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  return { periodStart: start, periodEnd: end };
}

function kes(cents: number): string {
  return `KES ${(cents / 100).toFixed(2)}`;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

/**
 * Admin dashboard (MVP critical journey): log in as an admin/ops/finance user, view the
 * period report + reconciliation overview, and run the (idempotent) reconcile sweep. Canonical
 * state always comes from REST; the reconcile action re-fetches the report afterwards.
 */
export function App({ api, initialPeriod }: AppProps): JSX.Element {
  const [token, setToken] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>(initialPeriod ?? defaultPeriod());
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (tok: string, p: Period) => {
      const [s, r] = await Promise.all([
        api.getReportSummary(tok, p),
        api.getReconciliationReport(tok),
      ]);
      setSummary(s);
      setReport(r);
    },
    [api],
  );

  async function onLogin(email: string, password: string): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const { access } = await api.login(email, password);
      setToken(access);
      await load(access, period);
    } catch {
      setError('Login failed');
    } finally {
      setBusy(false);
    }
  }

  async function onRefresh(): Promise<void> {
    if (!token) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await load(token, period);
      setAlert('Refreshed');
    } catch {
      setError('Failed to load');
    } finally {
      setBusy(false);
    }
  }

  async function onReconcile(): Promise<void> {
    if (!token) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.runReconcile(token);
      setAlert(
        `Reconcile complete — scanned ${result.scanned}, captured ${result.captured}, ` +
          `failed ${result.failed}, still pending ${result.stillPending}`,
      );
      await load(token, period);
    } catch {
      setError('Reconcile failed');
    } finally {
      setBusy(false);
    }
  }

  if (!token || !summary || !report) {
    return <LoginForm onLogin={onLogin} error={error} busy={busy} />;
  }

  return (
    <main>
      <h1>Admin dashboard</h1>
      {alert && <p role="status">{alert}</p>}
      {error && <p role="alert">{error}</p>}

      <section aria-label="Reporting period">
        <label>
          From
          <input
            type="date"
            aria-label="Period start"
            value={period.periodStart}
            onChange={(e) => setPeriod((p) => ({ ...p, periodStart: e.target.value }))}
          />
        </label>
        <label>
          To
          <input
            type="date"
            aria-label="Period end"
            value={period.periodEnd}
            onChange={(e) => setPeriod((p) => ({ ...p, periodEnd: e.target.value }))}
          />
        </label>
        <button type="button" onClick={() => void onRefresh()} disabled={busy}>
          Refresh
        </button>
      </section>

      <section aria-label="Summary">
        <h2>
          Summary {summary.periodStart} → {summary.periodEnd}
        </h2>
        <dl>
          <dt>GMV</dt>
          <dd>{kes(summary.gmvCents)}</dd>
          <dt>Orders</dt>
          <dd>{summary.orderCount}</dd>
          <dt>Delivered</dt>
          <dd>{summary.deliveredCount}</dd>
          <dt>Cancel rate</dt>
          <dd>{pct(summary.cancelRate)}</dd>
          <dt>Refund rate</dt>
          <dd>{pct(summary.refundRate)}</dd>
          <dt>Active riders</dt>
          <dd>{summary.rider.activeRiders}</dd>
          <dt>Rider deliveries</dt>
          <dd>{summary.rider.deliveries}</dd>
          <dt>Rider fees</dt>
          <dd>{kes(summary.rider.feesCents)}</dd>
        </dl>
      </section>

      <section aria-label="Reconciliation">
        <h2>Reconciliation</h2>
        <p data-testid="ledger-balanced">
          Ledger {report.ledgerBalanced ? 'balanced' : 'IMBALANCED'}
          {report.imbalancedTransactionCount > 0 &&
            ` (${report.imbalancedTransactionCount} unbalanced txns)`}
        </p>
        <button type="button" onClick={() => void onReconcile()} disabled={busy}>
          Run reconcile
        </button>
        {report.items.length === 0 ? (
          <p>No divergence.</p>
        ) : (
          <ul>
            {report.items.map((it) => (
              <li key={it.paymentUlid} data-testid={`divergence-${it.paymentUlid}`}>
                {it.paymentUlid} — {it.classification} (local {it.localStatus} / remote{' '}
                {it.remoteStatus}, {kes(it.amountCents)})
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function LoginForm({
  onLogin,
  error,
  busy,
}: {
  onLogin: (email: string, password: string) => void;
  error: string | null;
  busy: boolean;
}): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onLogin(email, password);
      }}
    >
      <h1>Admin sign in</h1>
      {error && <p role="alert">{error}</p>}
      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Email"
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Password"
        />
      </label>
      <button type="submit" disabled={busy}>
        Sign in
      </button>
    </form>
  );
}
