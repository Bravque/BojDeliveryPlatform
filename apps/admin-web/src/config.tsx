import { useCallback, useEffect, useState } from 'react';
import { ApiError, type AdminZone, type ApiClient, type FeeRule, type Promotion } from './api';
import { formatDateTime, formatKes, titleCase } from './format';
import { Badge, Button, EmptyState, Field, Modal, Select, Spinner, Toast } from './ui';

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

/** Parse a form string to a finite number, or undefined when blank/invalid. */
function num(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : undefined;
}

/**
 * Platform configuration: delivery zones (circle model) + their time-boxed fee rules, and
 * promotions. All writes are gated by `config:write` (admin) server-side; inputs are validated
 * for UX but the server is authoritative.
 */
export function ConfigView({ api, token }: { api: ApiClient; token: string }): JSX.Element {
  const [tab, setTab] = useState<'zones' | 'promotions'>('zones');
  return (
    <div>
      <div className="page-head">
        <h2 className="page-head__title">Configuration</h2>
        <div className="page-head__actions">
          <Button
            variant={tab === 'zones' ? 'primary' : 'ghost'}
            small
            onClick={() => setTab('zones')}
          >
            Zones &amp; fees
          </Button>
          <Button
            variant={tab === 'promotions' ? 'primary' : 'ghost'}
            small
            onClick={() => setTab('promotions')}
          >
            Promotions
          </Button>
        </div>
      </div>
      {tab === 'zones' ? (
        <ZonesPanel api={api} token={token} />
      ) : (
        <PromotionsPanel api={api} token={token} />
      )}
    </div>
  );
}

function ZonesPanel({ api, token }: { api: ApiClient; token: string }): JSX.Element {
  const [list, setList] = useState<AdminZone[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminZone | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setList(await api.listZones(token));
  }, [api, token]);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch {
        setError('Failed to load zones.');
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  function flash(msg: string): void {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  if (loading) {
    return <Spinner />;
  }

  const selectedZone = list?.find((z) => z.ulid === selected) ?? null;

  return (
    <div>
      <div className="panel__head">
        <h3 className="panel__title">Zones</h3>
        <Button small onClick={() => setCreating(true)}>
          New zone
        </Button>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {list && list.length === 0 ? (
        <EmptyState>No zones yet.</EmptyState>
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Town</th>
                  <th>Centre</th>
                  <th className="num">Radius (m)</th>
                  <th>Active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list?.map((z) => (
                  <tr
                    key={z.ulid}
                    data-testid={`zone-${z.ulid}`}
                    className="table__row--click"
                    onClick={() => setSelected(z.ulid)}
                  >
                    <td>{z.name}</td>
                    <td>{z.townName}</td>
                    <td className="table__mono">
                      {z.centerLat?.toFixed(4) ?? '—'}, {z.centerLng?.toFixed(4) ?? '—'}
                    </td>
                    <td className="num">{z.radiusM ?? '—'}</td>
                    <td>
                      {z.isActive ? <Badge tone="ok">Active</Badge> : <Badge tone="off">Off</Badge>}
                    </td>
                    <td>
                      <Button
                        small
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(z);
                        }}
                      >
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selectedZone && (
        <FeeRulesPanel api={api} token={token} zone={selectedZone} onFlash={flash} />
      )}

      {creating && (
        <ZoneModal
          api={api}
          token={token}
          onClose={() => setCreating(false)}
          onSaved={async (msg) => {
            setCreating(false);
            await refresh();
            flash(msg);
          }}
        />
      )}
      {editing && (
        <ZoneModal
          api={api}
          token={token}
          zone={editing}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            setEditing(null);
            await refresh();
            flash(msg);
          }}
        />
      )}

      {toast && <Toast message={toast} />}
    </div>
  );
}

function ZoneModal({
  api,
  token,
  zone,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  token: string;
  zone?: AdminZone;
  onClose: () => void;
  onSaved: (msg: string) => Promise<void>;
}): JSX.Element {
  const editingExisting = zone !== undefined;
  const [townName, setTownName] = useState(zone?.townName ?? 'Migori');
  const [name, setName] = useState(zone?.name ?? '');
  const [lat, setLat] = useState(zone ? String(zone.centerLat ?? '') : '');
  const [lng, setLng] = useState(zone ? String(zone.centerLng ?? '') : '');
  const [radius, setRadius] = useState(zone ? String(zone.radiusM ?? '') : '3000');
  const [active, setActive] = useState(zone ? (zone.isActive ? 'yes' : 'no') : 'yes');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setError(null);
    const centerLat = num(lat);
    const centerLng = num(lng);
    const radiusM = num(radius);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    if (centerLat === undefined || centerLng === undefined || radiusM === undefined) {
      setError('Centre coordinates and radius are required numbers.');
      return;
    }
    setBusy(true);
    try {
      if (editingExisting) {
        await api.updateZone(token, zone.ulid, {
          name: name.trim(),
          centerLat,
          centerLng,
          radiusM,
          isActive: active === 'yes',
        });
        await onSaved('Zone updated');
      } else {
        await api.createZone(token, {
          townName: townName.trim(),
          name: name.trim(),
          centerLat,
          centerLng,
          radiusM,
          isActive: active === 'yes',
        });
        await onSaved('Zone created');
      }
    } catch (e) {
      setError(errorMessage(e, 'Could not save the zone.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={editingExisting ? 'Edit zone' : 'New zone'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" small onClick={onClose}>
            Cancel
          </Button>
          <Button small disabled={busy} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!editingExisting && <Field label="Town" value={townName} onChange={setTownName} />}
      <Field label="Name" value={name} onChange={setName} autoFocus />
      <Field label="Centre latitude" value={lat} onChange={setLat} />
      <Field label="Centre longitude" value={lng} onChange={setLng} />
      <Field label="Radius (metres)" type="number" value={radius} onChange={setRadius} />
      <Select
        label="Active"
        value={active}
        onChange={setActive}
        options={[
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ]}
      />
    </Modal>
  );
}

function FeeRulesPanel({
  api,
  token,
  zone,
  onFlash,
}: {
  api: ApiClient;
  token: string;
  zone: AdminZone;
  onFlash: (msg: string) => void;
}): JSX.Element {
  const [list, setList] = useState<FeeRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setList(await api.listFeeRules(token, zone.ulid));
  }, [api, token, zone.ulid]);

  useEffect(() => {
    setList(null);
    (async () => {
      try {
        await refresh();
      } catch {
        setError('Failed to load fee rules.');
      }
    })();
  }, [refresh]);

  return (
    <section className="panel" aria-label={`Fee rules for ${zone.name}`}>
      <div className="panel__head">
        <h3 className="panel__title">Fee rules · {zone.name}</h3>
        <Button small onClick={() => setCreating(true)}>
          New fee rule
        </Button>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {list === null ? (
        <Spinner />
      ) : list.length === 0 ? (
        <EmptyState>No fee rules for this zone.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="num">Base</th>
                <th className="num">Per km</th>
                <th className="num">Min</th>
                <th className="num">Max</th>
                <th>Effective</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.ulid} data-testid={`fee-${r.ulid}`}>
                  <td className="num">{formatKes(r.baseFeeCents)}</td>
                  <td className="num">{formatKes(r.perKmCents)}</td>
                  <td className="num">{formatKes(r.minFeeCents)}</td>
                  <td className="num">{r.maxFeeCents === null ? '—' : formatKes(r.maxFeeCents)}</td>
                  <td>
                    {formatDateTime(r.effectiveFrom)}
                    {r.effectiveTo ? ` → ${formatDateTime(r.effectiveTo)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <FeeRuleModal
          api={api}
          token={token}
          zoneUlid={zone.ulid}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await refresh();
            onFlash('Fee rule created');
          }}
        />
      )}
    </section>
  );
}

function FeeRuleModal({
  api,
  token,
  zoneUlid,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  token: string;
  zoneUlid: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): JSX.Element {
  const [base, setBase] = useState('0');
  const [perKm, setPerKm] = useState('0');
  const [min, setMin] = useState('0');
  const [max, setMax] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setError(null);
    const baseFeeCents = num(base);
    const perKmCents = num(perKm) ?? 0;
    const minFeeCents = num(min);
    const maxFeeCents = num(max) ?? null;
    if (baseFeeCents === undefined || minFeeCents === undefined) {
      setError('Base and minimum fees are required (cents).');
      return;
    }
    setBusy(true);
    try {
      await api.createFeeRule(token, zoneUlid, {
        baseFeeCents,
        perKmCents,
        minFeeCents,
        maxFeeCents,
      });
      await onSaved();
    } catch (e) {
      setError(errorMessage(e, 'Could not save the fee rule.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New fee rule"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" small onClick={onClose}>
            Cancel
          </Button>
          <Button small disabled={busy} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Field label="Base fee (cents)" type="number" value={base} onChange={setBase} autoFocus />
      <Field label="Per km (cents)" type="number" value={perKm} onChange={setPerKm} />
      <Field label="Min fee (cents)" type="number" value={min} onChange={setMin} />
      <Field label="Max fee (cents, optional)" type="number" value={max} onChange={setMax} />
    </Modal>
  );
}

function promoValue(p: Promotion): string {
  if (p.type === 'percentage' && p.valueBps !== null) return `${(p.valueBps / 100).toFixed(2)}%`;
  if (p.type === 'fixed' && p.valueCents !== null) return formatKes(p.valueCents);
  return '—';
}

function PromotionsPanel({ api, token }: { api: ApiClient; token: string }): JSX.Element {
  const [list, setList] = useState<Promotion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setList(await api.listPromotions(token));
  }, [api, token]);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch {
        setError('Failed to load promotions.');
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  if (loading) {
    return <Spinner />;
  }

  return (
    <div>
      <div className="panel__head">
        <h3 className="panel__title">Promotions</h3>
        <Button small onClick={() => setCreating(true)}>
          New promotion
        </Button>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {list && list.length === 0 ? (
        <EmptyState>No promotions yet.</EmptyState>
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Type</th>
                  <th className="num">Value</th>
                  <th className="num">Min subtotal</th>
                  <th className="num">Redeemed</th>
                  <th>Window</th>
                  <th>Active</th>
                </tr>
              </thead>
              <tbody>
                {list?.map((p) => (
                  <tr key={p.ulid} data-testid={`promo-${p.ulid}`}>
                    <td className="table__mono">{p.code}</td>
                    <td>{titleCase(p.type)}</td>
                    <td className="num">{promoValue(p)}</td>
                    <td className="num">{formatKes(p.minSubtotalCents)}</td>
                    <td className="num">
                      {p.totalRedeemed}
                      {p.totalLimit !== null ? ` / ${p.totalLimit}` : ''}
                    </td>
                    <td>
                      {formatDateTime(p.startsAt)} → {formatDateTime(p.endsAt)}
                    </td>
                    <td>
                      {p.isActive ? <Badge tone="ok">Active</Badge> : <Badge tone="off">Off</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {creating && (
        <PromotionModal
          api={api}
          token={token}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await refresh();
            setToast('Promotion created');
            setTimeout(() => setToast(null), 3000);
          }}
        />
      )}

      {toast && <Toast message={toast} />}
    </div>
  );
}

function PromotionModal({
  api,
  token,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  token: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): JSX.Element {
  const [code, setCode] = useState('');
  const [type, setType] = useState<'percentage' | 'fixed' | 'free_delivery'>('percentage');
  const [value, setValue] = useState('');
  const [minSubtotal, setMinSubtotal] = useState('');
  const [maxDiscount, setMaxDiscount] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setError(null);
    if (!code.trim()) {
      setError('Code is required.');
      return;
    }
    if (!startsAt || !endsAt) {
      setError('Start and end dates are required.');
      return;
    }
    setBusy(true);
    try {
      await api.createPromotion(token, {
        code: code.trim(),
        type,
        valueBps: type === 'percentage' ? num(value) : undefined,
        valueCents: type === 'fixed' ? num(value) : undefined,
        maxDiscountCents: num(maxDiscount),
        minSubtotalCents: num(minSubtotal),
        startsAt,
        endsAt,
      });
      await onSaved();
    } catch (e) {
      setError(errorMessage(e, 'Could not create the promotion.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New promotion"
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
      <Field label="Code" value={code} onChange={setCode} autoFocus />
      <Select
        label="Type"
        value={type}
        onChange={(v) => setType(v as 'percentage' | 'fixed' | 'free_delivery')}
        options={[
          { value: 'percentage', label: 'Percentage' },
          { value: 'fixed', label: 'Fixed amount' },
          { value: 'free_delivery', label: 'Free delivery' },
        ]}
      />
      {type === 'percentage' && (
        <Field label="Value (bps, 1000 = 10%)" type="number" value={value} onChange={setValue} />
      )}
      {type === 'fixed' && (
        <Field label="Value (cents)" type="number" value={value} onChange={setValue} />
      )}
      <Field
        label="Min subtotal (cents, optional)"
        type="number"
        value={minSubtotal}
        onChange={setMinSubtotal}
      />
      <Field
        label="Max discount (cents, optional)"
        type="number"
        value={maxDiscount}
        onChange={setMaxDiscount}
      />
      <Field label="Starts at" type="date" value={startsAt} onChange={setStartsAt} />
      <Field label="Ends at" type="date" value={endsAt} onChange={setEndsAt} />
    </Modal>
  );
}
