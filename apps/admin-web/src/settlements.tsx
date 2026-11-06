import { useCallback, useEffect, useState } from 'react';
import { ApiError, type ApiClient, type Period, type SettlementView } from './api';
import { formatKes, last30Days, titleCase } from './format';
import { Badge, Button, EmptyState, Field, Spinner, Toast, toneForStatus } from './ui';

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

function shortUlid(ulid: string): string {
  return ulid.length > 8 ? `…${ulid.slice(-6)}` : ulid;
}

/**
 * Merchant settlements: generate per period (idempotent on merchant+period) and approve drafts
 * (finance). net = gross − commission − refunds. The list re-fetches after every mutation.
 */
export function SettlementsView({ api, token }: { api: ApiClient; token: string }): JSX.Element {
  const [list, setList] = useState<SettlementView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [draft, setDraft] = useState<Period>(last30Days());

  const refresh = useCallback(async () => {
    setList(await api.listSettlements(token));
  }, [api, token]);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch {
        setError('Failed to load settlements.');
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  function flash(msg: string): void {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function run(fn: () => Promise<unknown>, after: (r: unknown) => void): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      after(await fn());
      await refresh();
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
          <h2 className="page-head__title">Settlements</h2>
          <p className="page-head__sub">{list?.length ?? 0} total</p>
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
          <Button
            disabled={busy}
            onClick={() =>
              void run(
                () => api.generateSettlements(token, draft),
                (r) => {
                  const res = r as { generated: number; skipped: number };
                  setNotice(`Generated ${res.generated}, skipped ${res.skipped}.`);
                },
              )
            }
          >
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
        <EmptyState>No settlements yet — generate for a period.</EmptyState>
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Period</th>
                  <th className="num">Gross</th>
                  <th className="num">Commission</th>
                  <th className="num">Refunds</th>
                  <th className="num">Net</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list?.map((s) => (
                  <tr key={s.ulid} data-testid={`settlement-${s.ulid}`}>
                    <td className="table__mono">{shortUlid(s.merchantUlid)}</td>
                    <td>
                      {s.periodStart} → {s.periodEnd}
                    </td>
                    <td className="num">{formatKes(s.grossCents)}</td>
                    <td className="num">{formatKes(s.commissionCents)}</td>
                    <td className="num">{formatKes(s.refundsCents)}</td>
                    <td className="num">{formatKes(s.netCents)}</td>
                    <td>
                      <Badge tone={toneForStatus(s.status)}>{titleCase(s.status)}</Badge>
                    </td>
                    <td>
                      {s.status === 'draft' && (
                        <Button
                          small
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => api.approveSettlement(token, s.ulid),
                              () => flash('Settlement approved'),
                            )
                          }
                        >
                          Approve
                        </Button>
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
