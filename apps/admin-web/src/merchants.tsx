import { useCallback, useEffect, useState } from 'react';
import { ApiError, type AdminMerchant, type ApiClient } from './api';
import { formatDateTime, titleCase } from './format';
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  Field,
  Modal,
  Select,
  Spinner,
  Toast,
  toneForStatus,
} from './ui';

const CATEGORY_OPTIONS = ['restaurant', 'grocery', 'pharmacy', 'retail', 'other'].map((c) => ({
  value: c,
  label: titleCase(c),
}));

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

/**
 * Merchant operations: the onboarding roster + a create modal + a per-merchant action drawer
 * (approve, suspend, set payout destination, add owner). Every mutation is gated server-side; the
 * list is re-fetched after each so the table stays canonical.
 */
export function MerchantsView({ api, token }: { api: ApiClient; token: string }): JSX.Element {
  const [list, setList] = useState<AdminMerchant[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setList(await api.listMerchants(token));
  }, [api, token]);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch {
        setError('Failed to load merchants.');
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  function flash(msg: string): void {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  const selectedMerchant = list?.find((m) => m.ulid === selected) ?? null;

  if (loading) {
    return <Spinner />;
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Merchants</h2>
          <p className="page-head__sub">{list?.length ?? 0} total</p>
        </div>
        <div className="page-head__actions">
          <Button onClick={() => setCreating(true)}>New merchant</Button>
        </div>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {list && list.length === 0 ? (
        <EmptyState>No merchants yet.</EmptyState>
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Town</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th className="num">Commission</th>
                  <th>Payout</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {list?.map((m) => (
                  <tr
                    key={m.ulid}
                    data-testid={`merchant-${m.ulid}`}
                    className="table__row--click"
                    onClick={() => setSelected(m.ulid)}
                  >
                    <td>{m.name}</td>
                    <td>{m.townName}</td>
                    <td>{titleCase(m.categoryType)}</td>
                    <td>
                      <Badge tone={toneForStatus(m.status)}>{titleCase(m.status)}</Badge>
                    </td>
                    <td className="num">{(m.commissionBps / 100).toFixed(2)}%</td>
                    <td>
                      {m.payoutPhoneE164 ? (
                        <Badge tone="ok">Set</Badge>
                      ) : (
                        <Badge tone="warn">None</Badge>
                      )}
                    </td>
                    <td>{formatDateTime(m.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {creating && (
        <CreateMerchantModal
          api={api}
          token={token}
          onClose={() => setCreating(false)}
          onCreated={async (name) => {
            setCreating(false);
            await refresh();
            flash(`Created ${name}`);
          }}
        />
      )}

      {selectedMerchant && (
        <MerchantDrawer
          api={api}
          token={token}
          merchant={selectedMerchant}
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

function CreateMerchantModal({
  api,
  token,
  onClose,
  onCreated,
}: {
  api: ApiClient;
  token: string;
  onClose: () => void;
  onCreated: (name: string) => Promise<void>;
}): JSX.Element {
  const [townName, setTownName] = useState('Migori');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('restaurant');
  const [commission, setCommission] = useState('1000');
  const [prep, setPrep] = useState('20');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setError(null);
    const commissionBps = Number(commission);
    const prepMinutes = Number(prep);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
      setError('Commission must be a whole number of basis points (0–10000).');
      return;
    }
    setBusy(true);
    try {
      await api.createMerchant(token, {
        townName: townName.trim(),
        name: name.trim(),
        categoryType: category,
        commissionBps,
        prepMinutes: Number.isInteger(prepMinutes) ? prepMinutes : undefined,
      });
      await onCreated(name.trim());
    } catch (e) {
      setError(errorMessage(e, 'Could not create the merchant.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New merchant"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" small onClick={onClose}>
            Cancel
          </Button>
          <Button small disabled={busy} onClick={() => void submit()}>
            Create
          </Button>
        </>
      }
    >
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Field label="Town" value={townName} onChange={setTownName} />
      <Field label="Name" value={name} onChange={setName} autoFocus />
      <Select label="Category" value={category} onChange={setCategory} options={CATEGORY_OPTIONS} />
      <Field
        label="Commission (bps, 1000 = 10%)"
        type="number"
        value={commission}
        onChange={setCommission}
      />
      <Field label="Prep minutes" type="number" value={prep} onChange={setPrep} />
    </Modal>
  );
}

function MerchantDrawer({
  api,
  token,
  merchant,
  onClose,
  onChanged,
}: {
  api: ApiClient;
  token: string;
  merchant: AdminMerchant;
  onClose: () => void;
  onChanged: (msg: string) => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [phone, setPhone] = useState(merchant.payoutPhoneE164 ?? '');
  const [ownerUlid, setOwnerUlid] = useState('');
  const [ownerRole, setOwnerRole] = useState('owner');

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
      title={merchant.name}
      subtitle={<Badge tone={toneForStatus(merchant.status)}>{titleCase(merchant.status)}</Badge>}
      onClose={onClose}
    >
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <p className="field__label">Onboarding</p>
      <div className="row" style={{ marginBottom: 18 }}>
        {merchant.status !== 'approved' && (
          <Button
            small
            disabled={busy}
            onClick={() =>
              void act(() => api.approveMerchant(token, merchant.ulid), 'Merchant approved')
            }
          >
            Approve
          </Button>
        )}
        {merchant.status === 'approved' && <span className="muted">Approved and live.</span>}
      </div>

      {merchant.status !== 'suspended' && (
        <div style={{ marginBottom: 18 }}>
          <Field label="Suspend — reason" value={reason} onChange={setReason} />
          <Button
            variant="danger"
            small
            disabled={busy || !reason.trim()}
            onClick={() =>
              void act(
                () => api.suspendMerchant(token, merchant.ulid, reason.trim()),
                'Merchant suspended',
              )
            }
          >
            Suspend
          </Button>
        </div>
      )}

      <p className="field__label">Payout destination (M-Pesa)</p>
      <div className="row" style={{ marginBottom: 18 }}>
        <Field label="Phone" value={phone} onChange={setPhone} inline />
        <Button
          small
          disabled={busy || !phone.trim()}
          onClick={() =>
            void act(
              () => api.setMerchantPayoutDestination(token, merchant.ulid, phone.trim()),
              'Payout destination saved',
            )
          }
        >
          Save
        </Button>
      </div>

      <p className="field__label">Add owner / staff</p>
      <div className="row">
        <Field label="User ULID" value={ownerUlid} onChange={setOwnerUlid} inline />
        <Select
          label="Role"
          value={ownerRole}
          onChange={setOwnerRole}
          inline
          options={[
            { value: 'owner', label: 'Owner' },
            { value: 'staff', label: 'Staff' },
          ]}
        />
        <Button
          small
          disabled={busy || !ownerUlid.trim()}
          onClick={() =>
            void act(
              () =>
                api.addMerchantOwner(
                  token,
                  merchant.ulid,
                  ownerUlid.trim(),
                  ownerRole === 'staff' ? 'staff' : 'owner',
                ),
              'Owner added',
            )
          }
        >
          Add
        </Button>
      </div>
    </Drawer>
  );
}
