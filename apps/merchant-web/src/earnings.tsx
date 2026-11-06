/**
 * Earnings — the merchant's own settlements (read-only), from GET /merchant/settlements. Each
 * settlement is a period's net = gross − commission − refunds, with a status (draft/approved/paid/
 * failed). Money is formatted via the shared `formatKes`.
 */
import { useEffect, useState } from 'react';
import type { ApiClient, SettlementView } from './api';
import { formatKes, statusLabel } from './format';
import { Badge, EmptyState, Spinner, type Tone } from './ui';

function statusTone(status: string): Tone {
  if (status === 'paid') return 'ok';
  if (status === 'approved') return 'info';
  if (status === 'failed') return 'off';
  return 'neutral';
}

export function EarningsView({ api, token }: { api: ApiClient; token: string }): JSX.Element {
  const [settlements, setSettlements] = useState<SettlementView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setSettlements(await api.listSettlements(token));
      } catch {
        setError('Could not load earnings.');
      } finally {
        setLoading(false);
      }
    })();
  }, [api, token]);

  if (loading) {
    return <Spinner />;
  }
  if (error) {
    return (
      <div className="card">
        <EmptyState>{error}</EmptyState>
      </div>
    );
  }
  const list = settlements ?? [];
  const totalNet = list.reduce((s, x) => s + x.netCents, 0);

  return (
    <>
      <div className="menu-head">
        <h2 className="menu-head__title">Earnings</h2>
        {list.length > 0 && (
          <span className="badge badge--ok">Net to date: {formatKes(totalNet)}</span>
        )}
      </div>

      {list.length === 0 ? (
        <div className="card">
          <EmptyState>
            No settlements yet. Earnings appear here once your delivered orders are settled.
          </EmptyState>
        </div>
      ) : (
        list.map((s) => (
          <div className="settle" key={s.ulid}>
            <div className="settle__head">
              <span className="settle__period">
                {s.periodStart} → {s.periodEnd}
              </span>
              <Badge tone={statusTone(s.status)}>{statusLabel(s.status)}</Badge>
            </div>
            <div className="settle__grid">
              <Figure label="Gross" value={formatKes(s.grossCents)} />
              <Figure label="Commission" value={`−${formatKes(s.commissionCents)}`} />
              <Figure label="Refunds" value={`−${formatKes(s.refundsCents)}`} />
              <Figure label="Net" value={formatKes(s.netCents)} strong />
            </div>
          </div>
        ))
      )}
    </>
  );
}

function Figure({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}): JSX.Element {
  return (
    <div className="settle__fig">
      <span className="settle__fig-label">{label}</span>
      <span className={`settle__fig-value${strong ? ' settle__fig-value--strong' : ''}`}>
        {value}
      </span>
    </div>
  );
}
