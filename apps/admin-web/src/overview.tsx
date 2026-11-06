import { useCallback, useEffect, useState } from 'react';
import type { ApiClient, LedgerOverview, Period, ReconciliationReport, ReportSummary } from './api';
import { formatKes, formatPct, titleCase } from './format';
import { Badge, Button, Field, Spinner, Stat } from './ui';

/**
 * Insights overview: period business summary (GMV, volumes, cancel/refund rates, rider
 * utilization), the ledger account positions + invariant flag, and the payment reconciliation
 * view with the idempotent reconcile sweep. Canonical state always comes from REST; the reconcile
 * action re-fetches the reconciliation report + ledger afterwards.
 */
export function OverviewView({
  api,
  token,
  initialPeriod,
}: {
  api: ApiClient;
  token: string;
  initialPeriod: Period;
}): JSX.Element {
  const [period, setPeriod] = useState<Period>(initialPeriod);
  const [draft, setDraft] = useState<Period>(initialPeriod);
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [ledger, setLedger] = useState<LedgerOverview | null>(null);
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [s, l, r] = await Promise.all([
        api.getReportSummary(token, period),
        api.getLedger(token),
        api.getReconciliationReport(token),
      ]);
      setSummary(s);
      setLedger(l);
      setReport(r);
    } catch {
      setError('Failed to load the overview.');
    } finally {
      setBusy(false);
      setLoading(false);
    }
  }, [api, token, period]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onReconcile(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api.runReconcile(token);
      setNotice(
        `Reconcile complete — scanned ${result.scanned}, captured ${result.captured}, ` +
          `failed ${result.failed}, still pending ${result.stillPending}.`,
      );
      const [l, r] = await Promise.all([api.getLedger(token), api.getReconciliationReport(token)]);
      setLedger(l);
      setReport(r);
    } catch {
      setError('Reconcile failed.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <Spinner />;
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Overview</h2>
          {summary && (
            <p className="page-head__sub">
              {summary.periodStart} → {summary.periodEnd}
            </p>
          )}
        </div>
        <div className="page-head__actions">
          <Field
            label="From"
            type="date"
            inline
            value={draft.periodStart}
            onChange={(v) => setDraft((d) => ({ ...d, periodStart: v }))}
          />
          <Field
            label="To"
            type="date"
            inline
            value={draft.periodEnd}
            onChange={(v) => setDraft((d) => ({ ...d, periodEnd: v }))}
          />
          <Button variant="ghost" small disabled={busy} onClick={() => setPeriod(draft)}>
            Apply
          </Button>
        </div>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {summary && (
        <div className="kpi-grid">
          <Stat label="GMV" value={formatKes(summary.gmvCents)} hint="Delivered order value" />
          <Stat
            label="Orders"
            value={summary.orderCount}
            hint={`${summary.deliveredCount} delivered`}
          />
          <Stat
            label="Cancel rate"
            value={formatPct(summary.cancelRate)}
            hint={`${summary.cancelledCount} cancelled`}
          />
          <Stat
            label="Refund rate"
            value={formatPct(summary.refundRate)}
            hint={`${summary.refundedCount} refunded`}
          />
          <Stat
            label="Active riders"
            value={summary.rider.activeRiders}
            hint={`${summary.rider.deliveries} deliveries`}
          />
          <Stat
            label="Rider fees"
            value={formatKes(summary.rider.feesCents)}
            hint="Accrued this period"
          />
        </div>
      )}

      {ledger && (
        <section className="panel" aria-label="Ledger">
          <div className="panel__head">
            <h3 className="panel__title">Ledger</h3>
            <Badge tone={ledger.balanced ? 'ok' : 'off'}>
              {ledger.balanced ? 'Balanced' : `${ledger.imbalancedTransactionCount} imbalanced`}
            </Badge>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th className="num">Debit</th>
                  <th className="num">Credit</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {ledger.accounts.map((a) => (
                  <tr key={a.code} data-testid={`account-${a.code}`}>
                    <td className="table__mono">{a.code}</td>
                    <td>{titleCase(a.type)}</td>
                    <td className="num">{formatKes(a.debitCents)}</td>
                    <td className="num">{formatKes(a.creditCents)}</td>
                    <td className="num">{formatKes(a.balanceCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report && (
        <section className="panel" aria-label="Payment reconciliation">
          <div className="panel__head">
            <h3 className="panel__title">Payment reconciliation</h3>
            <Button variant="primary" small disabled={busy} onClick={() => void onReconcile()}>
              Run reconcile
            </Button>
          </div>
          <p data-testid="ledger-balanced">
            Ledger {report.ledgerBalanced ? 'balanced' : 'IMBALANCED'}
            {report.imbalancedTransactionCount > 0 &&
              ` (${report.imbalancedTransactionCount} unbalanced txns)`}
          </p>
          {notice && (
            <p role="status" className="muted">
              {notice}
            </p>
          )}
          {report.items.length === 0 ? (
            <p className="muted">No divergence.</p>
          ) : (
            <div className="rows">
              {report.items.map((it) => (
                <div
                  className="rows__item"
                  key={it.paymentUlid}
                  data-testid={`divergence-${it.paymentUlid}`}
                >
                  <div className="rows__main">
                    <div className="rows__name table__mono">{it.paymentUlid}</div>
                    <div className="rows__meta">
                      {titleCase(it.classification)} · local {it.localStatus} / remote{' '}
                      {it.remoteStatus}
                    </div>
                  </div>
                  <div className="rows__value">{formatKes(it.amountCents)}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
