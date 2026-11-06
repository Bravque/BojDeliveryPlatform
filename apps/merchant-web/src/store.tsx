/**
 * Store settings: open/closed + preparation time. The current state is read from the public
 * `GET /merchants/:ulid` (which exposes `isOpen`/`prepMinutes`); changes go through
 * `PATCH /merchant/profile` and then re-read so the view is canonical.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ApiClient, PublicMerchant } from './api';
import { Badge, Button, EmptyState, Field, Spinner, Switch } from './ui';

export function StoreView({
  api,
  token,
  merchantUlid,
}: {
  api: ApiClient;
  token: string;
  merchantUlid: string;
}): JSX.Element {
  const [merchant, setMerchant] = useState<PublicMerchant | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prep, setPrep] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    const m = await api.getPublicMerchant(merchantUlid);
    setMerchant(m);
    setPrep(String(m.prepMinutes));
  }, [api, merchantUlid]);

  useEffect(() => {
    (async () => {
      try {
        await load();
      } catch {
        setError('Could not load store settings.');
      } finally {
        setLoading(false);
      }
    })();
  }, [load]);

  async function apply(
    patch: { isOpen?: boolean; prepMinutes?: number },
    msg: string,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await api.updateProfile(token, patch);
      await load();
      setSaved(msg);
    } catch {
      setError('Could not update store settings.');
    } finally {
      setBusy(false);
    }
  }

  function savePrep(): void {
    const n = Math.floor(Number(prep));
    if (!Number.isFinite(n) || n < 1) {
      setError('Enter a valid preparation time in minutes.');
      return;
    }
    void apply({ prepMinutes: n }, 'Preparation time saved');
  }

  if (loading) {
    return <Spinner />;
  }
  if (!merchant) {
    return (
      <div className="card">
        <EmptyState>{error ?? 'Could not load store settings.'}</EmptyState>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 520 }}>
      <h2 className="menu-head__title" style={{ marginBottom: 18 }}>
        Store
      </h2>
      {saved && (
        <p className="field-error" style={{ color: 'var(--green-dark)' }} role="status">
          {saved}
        </p>
      )}
      {error && <p className="field-error">{error}</p>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div className="product-row__name">Store status</div>
            <div className="product-row__meta">
              <span>{merchant.isOpen ? 'Accepting orders' : 'Not accepting orders'}</span>
              <span>{merchant.townName}</span>
            </div>
          </div>
          <div className="row">
            <Badge tone={merchant.isOpen ? 'ok' : 'off'}>
              {merchant.isOpen ? 'Open' : 'Closed'}
            </Badge>
            <Switch
              checked={merchant.isOpen}
              onChange={() => void apply({ isOpen: !merchant.isOpen }, 'Store status updated')}
              label="Toggle store open"
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="product-row__name" style={{ marginBottom: 12 }}>
          Preparation time
        </div>
        <Field label="Minutes" value={prep} onChange={setPrep} />
        <Button variant="primary" disabled={busy} onClick={savePrep}>
          Save prep time
        </Button>
      </div>
    </div>
  );
}
