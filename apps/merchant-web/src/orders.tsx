/**
 * Orders board + detail drawer (presentational). State (fetching detail, firing actions, re-fetching)
 * lives in `App.tsx`; these components render what they're given and call back on interaction.
 */
import { useState } from 'react';
import type { MerchantOrderDetail, OrderSummary } from './api';
import { formatKes, statusLabel, timeAgo } from './format';
import { Badge, Button, Drawer, EmptyState, Spinner, type Tone } from './ui';

export type OrderAction = 'accept' | 'preparing' | 'ready' | 'reject';

interface Column {
  key: string;
  title: string;
  statuses: string[];
}

const COLUMNS: Column[] = [
  { key: 'new', title: 'New', statuses: ['placed'] },
  { key: 'accepted', title: 'Accepted', statuses: ['merchant_accepted'] },
  { key: 'preparing', title: 'Preparing', statuses: ['preparing'] },
  { key: 'ready', title: 'Ready', statuses: ['ready_for_pickup'] },
  {
    key: 'history',
    title: 'History',
    statuses: ['out_for_delivery', 'delivered', 'cancelled', 'rejected', 'refunded'],
  },
];

function paymentTone(paymentStatus: string): Tone {
  if (paymentStatus === 'paid') return 'ok';
  if (paymentStatus === 'refunded' || paymentStatus === 'partially_refunded') return 'warn';
  if (paymentStatus === 'failed') return 'off';
  return 'neutral';
}

function columnFor(status: string): string {
  return COLUMNS.find((c) => c.statuses.includes(status))?.key ?? 'history';
}

function OrderCard({
  order,
  onOpen,
}: {
  order: OrderSummary;
  onOpen: (ulid: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="order-card"
      data-testid={`order-${order.ulid}`}
      onClick={() => onOpen(order.ulid)}
    >
      <div className="order-card__top">
        <span className="order-card__num">{order.orderNumber}</span>
        <span className="order-card__age">{timeAgo(order.createdAt)}</span>
      </div>
      <div className="order-card__bottom">
        <span className="order-card__total">{formatKes(order.totalCents)}</span>
        <Badge tone={paymentTone(order.paymentStatus)}>{statusLabel(order.paymentStatus)}</Badge>
      </div>
    </button>
  );
}

export function OrdersBoard({
  orders,
  onOpen,
}: {
  orders: OrderSummary[];
  onOpen: (ulid: string) => void;
}): JSX.Element {
  if (orders.length === 0) {
    return <EmptyState>No orders yet. New orders will appear here in realtime.</EmptyState>;
  }
  const byColumn = new Map<string, OrderSummary[]>();
  for (const o of orders) {
    const key = columnFor(o.status);
    const list = byColumn.get(key) ?? [];
    list.push(o);
    byColumn.set(key, list);
  }
  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const list = byColumn.get(col.key) ?? [];
        return (
          <section className="column" key={col.key} aria-label={col.title}>
            <div className="column__head">
              <span className="column__title">{col.title}</span>
              <span className="column__count">{list.length}</span>
            </div>
            <div className="column__body">
              {list.map((o) => (
                <OrderCard key={o.ulid} order={o} onOpen={onOpen} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function actionsFor(status: string): { accept?: boolean; preparing?: boolean; ready?: boolean } {
  if (status === 'placed') return { accept: true };
  if (status === 'merchant_accepted') return { preparing: true };
  if (status === 'preparing') return { ready: true };
  return {};
}

export function OrderDrawer({
  detail,
  loading,
  busy,
  onClose,
  onAction,
}: {
  detail: MerchantOrderDetail | null;
  loading: boolean;
  busy: boolean;
  onClose: () => void;
  onAction: (action: OrderAction, reason?: string) => void;
}): JSX.Element {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const title = detail ? detail.orderNumber : 'Order';
  const acts = detail ? actionsFor(detail.status) : {};

  const footer = detail ? (
    rejecting ? (
      <>
        <input
          className="input"
          aria-label="Rejection reason"
          placeholder="Reason (e.g. out of stock)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button
          variant="danger"
          disabled={busy || reason.trim().length === 0}
          onClick={() => onAction('reject', reason.trim())}
        >
          Confirm reject
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>
          Cancel
        </Button>
      </>
    ) : (
      <>
        {acts.accept && (
          <Button variant="primary" disabled={busy} onClick={() => onAction('accept')}>
            Accept
          </Button>
        )}
        {acts.preparing && (
          <Button variant="primary" disabled={busy} onClick={() => onAction('preparing')}>
            Start preparing
          </Button>
        )}
        {acts.ready && (
          <Button variant="primary" disabled={busy} onClick={() => onAction('ready')}>
            Mark ready
          </Button>
        )}
        {acts.accept && (
          <Button variant="danger" disabled={busy} onClick={() => setRejecting(true)}>
            Reject
          </Button>
        )}
      </>
    )
  ) : undefined;

  const subtitle = detail ? (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Badge tone="info">{statusLabel(detail.status)}</Badge>
      <Badge tone={paymentTone(detail.paymentStatus)}>{statusLabel(detail.paymentStatus)}</Badge>
    </div>
  ) : undefined;

  return (
    <Drawer title={title} subtitle={subtitle} onClose={onClose} footer={footer}>
      {loading || !detail ? (
        <Spinner />
      ) : (
        <>
          <p className="section-label">Items</p>
          {detail.items.map((item, i) => (
            <div className="lineitem" key={`${item.productUlid}-${i}`}>
              <div style={{ display: 'flex', gap: 10 }}>
                <span className="lineitem__qty">{item.quantity}×</span>
                <div>
                  <div className="lineitem__name">{item.name}</div>
                  {item.options.map((opt, j) => (
                    <div className="lineitem__opt" key={j}>
                      + {opt.name}
                      {opt.priceDeltaCents > 0 ? ` (${formatKes(opt.priceDeltaCents)})` : ''}
                    </div>
                  ))}
                </div>
              </div>
              <span className="lineitem__price">{formatKes(item.lineTotalCents)}</span>
            </div>
          ))}

          <div className="totals">
            <div className="totals__row">
              <span>Subtotal</span>
              <span>{formatKes(detail.subtotalCents)}</span>
            </div>
            <div className="totals__row">
              <span>Delivery</span>
              <span>{formatKes(detail.deliveryFeeCents)}</span>
            </div>
            {detail.serviceFeeCents > 0 && (
              <div className="totals__row">
                <span>Service</span>
                <span>{formatKes(detail.serviceFeeCents)}</span>
              </div>
            )}
            {detail.discountCents > 0 && (
              <div className="totals__row">
                <span>Discount</span>
                <span>−{formatKes(detail.discountCents)}</span>
              </div>
            )}
            <div className="totals__row totals__row--grand">
              <span>Total</span>
              <span>{formatKes(detail.totalCents)}</span>
            </div>
          </div>
        </>
      )}
    </Drawer>
  );
}
