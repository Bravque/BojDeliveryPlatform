import { useCallback, useEffect, useState } from 'react';
import { ApiError, type ApiClient, type RefundListItem } from './api';
import { formatDateTime, formatKes, titleCase } from './format';
import { Badge, Button, EmptyState, Spinner, Toast, toneForStatus } from './ui';

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

/**
 * Refund approval queue: approve (→ begins the provider reversal) or reject requested refunds.
 * Separation of duties is enforced server-side (an approver may not be the requester) — a 403 is
 * surfaced in-place. Refund *creation* is an order-side action and lives outside this console.
 */
export function RefundsView({ api, token }: { api: ApiClient; token: string }): JSX.Element {
  const [list, setList] = useState<RefundListItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setList(await api.listRefunds(token));
  }, [api, token]);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch {
        setError('Failed to load refunds.');
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

  if (loading) {
    return <Spinner />;
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Refunds</h2>
          <p className="page-head__sub">{list?.length ?? 0} total</p>
        </div>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {list && list.length === 0 ? (
        <EmptyState>No refunds yet.</EmptyState>
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th className="num">Amount</th>
                  <th>Reason</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Requested</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list?.map((r) => (
                  <tr key={r.ulid} data-testid={`refund-${r.ulid}`}>
                    <td className="table__mono">{r.orderNumber ?? r.orderUlid ?? '—'}</td>
                    <td className="num">{formatKes(r.amountCents)}</td>
                    <td>{r.reason}</td>
                    <td>{titleCase(r.source)}</td>
                    <td>
                      <Badge tone={toneForStatus(r.status)}>{titleCase(r.status)}</Badge>
                    </td>
                    <td>{formatDateTime(r.createdAt)}</td>
                    <td>
                      {r.status === 'requested' && (
                        <div className="row">
                          <Button
                            small
                            disabled={busy}
                            onClick={() =>
                              void run(() => api.approveRefund(token, r.ulid), 'Refund approved')
                            }
                          >
                            Approve
                          </Button>
                          <Button
                            small
                            variant="danger"
                            disabled={busy}
                            onClick={() =>
                              void run(() => api.rejectRefund(token, r.ulid), 'Refund rejected')
                            }
                          >
                            Reject
                          </Button>
                        </div>
                      )}
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
