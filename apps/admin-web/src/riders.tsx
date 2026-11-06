import { useCallback, useEffect, useState } from 'react';
import { ApiError, type AdminRider, type ApiClient } from './api';
import { formatDateTime, titleCase } from './format';
import { Badge, Button, Drawer, EmptyState, Field, Spinner, Toast, toneForStatus } from './ui';

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

/**
 * Rider operations: the onboarding roster + a per-rider action drawer (approve → grants the rider
 * role; suspend with a reason). The list re-fetches after each mutation.
 */
export function RidersView({ api, token }: { api: ApiClient; token: string }): JSX.Element {
  const [list, setList] = useState<AdminRider[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setList(await api.listRiders(token));
  }, [api, token]);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch {
        setError('Failed to load riders.');
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  function flash(msg: string): void {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  const selectedRider = list?.find((r) => r.userUlid === selected) ?? null;

  if (loading) {
    return <Spinner />;
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Riders</h2>
          <p className="page-head__sub">{list?.length ?? 0} total</p>
        </div>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {list && list.length === 0 ? (
        <EmptyState>No riders yet.</EmptyState>
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Phone</th>
                  <th>Status</th>
                  <th>Vehicle</th>
                  <th>Presence</th>
                  <th>Payout</th>
                  <th>Applied</th>
                </tr>
              </thead>
              <tbody>
                {list?.map((r) => (
                  <tr
                    key={r.userUlid}
                    data-testid={`rider-${r.userUlid}`}
                    className="table__row--click"
                    onClick={() => setSelected(r.userUlid)}
                  >
                    <td>{r.phoneE164 ?? <span className="muted">—</span>}</td>
                    <td>
                      <Badge tone={toneForStatus(r.status)}>{titleCase(r.status)}</Badge>
                    </td>
                    <td>{titleCase(r.vehicleType)}</td>
                    <td>{r.isOnline ? <Badge tone="ok">Online</Badge> : <Badge>Offline</Badge>}</td>
                    <td>
                      {r.payoutPhoneE164 ? <Badge tone="ok">Set</Badge> : <Badge>Default</Badge>}
                    </td>
                    <td>{formatDateTime(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selectedRider && (
        <RiderDrawer
          api={api}
          token={token}
          rider={selectedRider}
          onClose={() => setSelected(null)}
          onChanged={async (msg) => {
            await refresh();
            flash(msg);
          }}
        />
      )}

      {toast && <Toast message={toast} />}
    </div>
  );
}

function RiderDrawer({
  api,
  token,
  rider,
  onClose,
  onChanged,
}: {
  api: ApiClient;
  token: string;
  rider: AdminRider;
  onClose: () => void;
  onChanged: (msg: string) => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  async function act(fn: () => Promise<unknown>, okMsg: string): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await onChanged(okMsg);
    } catch (e) {
      setError(errorMessage(e, 'Action failed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={rider.phoneE164 ?? rider.userUlid}
      subtitle={<Badge tone={toneForStatus(rider.status)}>{titleCase(rider.status)}</Badge>}
      onClose={onClose}
    >
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <p className="field__label">Vehicle</p>
      <p style={{ marginTop: 0 }}>{titleCase(rider.vehicleType)}</p>

      <p className="field__label">Onboarding</p>
      <div className="row" style={{ marginBottom: 18 }}>
        {rider.status !== 'approved' && (
          <Button
            small
            disabled={busy}
            onClick={() =>
              void act(() => api.approveRider(token, rider.userUlid), 'Rider approved')
            }
          >
            Approve
          </Button>
        )}
        {rider.status === 'approved' && <span className="muted">Approved and active.</span>}
      </div>

      {rider.status !== 'suspended' && (
        <div>
          <Field label="Suspend — reason" value={reason} onChange={setReason} />
          <Button
            variant="danger"
            small
            disabled={busy || !reason.trim()}
            onClick={() =>
              void act(
                () => api.suspendRider(token, rider.userUlid, reason.trim()),
                'Rider suspended',
              )
            }
          >
            Suspend
          </Button>
        </div>
      )}
    </Drawer>
  );
}
