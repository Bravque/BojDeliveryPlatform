import { useCallback, useEffect, useState } from 'react';
import { ApiError, type ApiClient, type PayoutView, type Period } from './api';
import { formatKes, last30Days, titleCase } from './format';
import { Badge, Button, EmptyState, Field, Spinner, Toast, toneForStatus } from './ui';

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

/**
 * Payouts: generate per period, then **dual-sign** (a finance approval AND an ops approval, by two
 * distinct users) before executing the simulated M-Pesa B2C. A payout reaches `paid` only on the
 * confirmed provider result (webhook / dev-confirm) — the console reflects status, it never fakes it.
 */
export function PayoutsView({ api, token }: { api: ApiClient; token: string }): JSX.Element {
  const [list, setList] = useState<PayoutView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [draft, setDraft] = useState<Period>(last30Days());

  const refresh = useCallback(async () => {
    setList(await api.listPayouts(token));
  }, [api, token]);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch {
        setError('Failed to load payouts.');
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  function flash(msg: string): void {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function run(fn: () => Promise<unknown>, okMsg: string): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await refresh();
      flash(okMsg);
    } catch (e) {
      setError(errorMessage(e, 'Action failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function onGenerate(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const r = await api.generatePayouts(token, draft);
      setNotice(`Generated ${r.generated}, skipped ${r.skipped}.`);
      await refresh();
    } catch (e) {
      setError(errorMessage(e, 'Generate failed.'));
    } finally {
      setBusy(false);
    }
  }

  const check = (ok: boolean): JSX.Element =>
    ok ? <Badge tone="ok">✓</Badge> : <span className="muted">—</span>;

  if (loading) {
    return <Spinner />;
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Payouts</h2>
          <p className="page-head__sub">{list?.length ?? 0} total · dual-sign required</p>
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
          <Button disabled={busy} onClick={() => void onGenerate()}>
            Generate
          </Button>
        </div>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}

      {list && list.length === 0 ? (
        <EmptyState>No payouts yet — generate for a period.</EmptyState>
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Payee</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th>Finance</th>
                  <th>Ops</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list?.map((p) => (
                  <tr key={p.ulid} data-testid={`payout-${p.ulid}`}>
                    <td>{titleCase(p.payeeType)}</td>
                    <td className="num">{formatKes(p.amountCents)}</td>
                    <td>
                      <Badge tone={toneForStatus(p.status)}>{titleCase(p.status)}</Badge>
                    </td>
                    <td>{check(p.financeApproved)}</td>
                    <td>{check(p.opsApproved)}</td>
                    <td>
                      <div className="row">
                        {!p.financeApproved && (
                          <Button
                            small
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () => api.approvePayoutFinance(token, p.ulid),
                                'Finance approval recorded',
                              )
                            }
                          >
                            Approve (finance)
                          </Button>
                        )}
                        {!p.opsApproved && (
                          <Button
                            small
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () => api.approvePayoutOps(token, p.ulid),
                                'Ops approval recorded',
                              )
                            }
                          >
                            Approve (ops)
                          </Button>
                        )}
                        {p.financeApproved && p.opsApproved && p.status === 'approved' && (
                          <Button
                            small
                            disabled={busy}
                            onClick={() =>
                              void run(() => api.executePayout(token, p.ulid), 'Payout executing')
                            }
                          >
                            Execute
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {toast && <Toast message={toast} />}
    </div>
  );
}
