import { merchantPayableCode } from '../ledger/accounts';
import type { PostingLine } from '../ledger/ledger-service';
import type { OrderMoneySnapshot } from './capture';

/** Refund lifecycle (doc 07 §8). */
export type RefundStatus =
  'requested' | 'approved' | 'processing' | 'completed' | 'failed' | 'rejected';
export type RefundSource = 'manual' | 'auto';

export interface RefundRecord {
  id: number;
  ulid: string;
  orderId: number;
  paymentId: number;
  amountCents: number;
  reason: string;
  status: RefundStatus;
  source: RefundSource;
  requestedBy: number | null;
  approvedBy: number | null;
  providerRef: string | null;
  idempotencyKey: string;
}

/**
 * Ledger reversal for a refund (doc 07 §7). A **full** refund (the whole order total, no prior
 * partials) mirrors the capture exactly — every party's earnings are reversed and the platform
 * recovers the promo expense — swapping `mpesa_clearing` for `refunds_payable`. A **partial**
 * refund is borne by the merchant (user decision): clawed back from `merchant_payable` into
 * `refunds_payable`. The cash outflow out of `refunds_payable` is settled at payout (Phase 7).
 */
export function buildRefundLines(
  s: OrderMoneySnapshot,
  amountCents: number,
  isFull: boolean,
): PostingLine[] {
  if (isFull) {
    const lines: PostingLine[] = [
      {
        accountCode: merchantPayableCode(s.merchantId),
        accountType: 'liability',
        ownerType: 'merchant',
        ownerId: s.merchantId,
        direction: 'debit',
        amountCents: s.subtotalCents - s.commissionCents,
      },
      {
        accountCode: 'commission_revenue',
        accountType: 'revenue',
        direction: 'debit',
        amountCents: s.commissionCents,
      },
    ];
    if (s.deliveryFeeCents > 0) {
      lines.push({
        accountCode: 'platform_delivery_income',
        accountType: 'revenue',
        direction: 'debit',
        amountCents: s.deliveryFeeCents,
      });
    }
    if (s.serviceFeeCents > 0) {
      lines.push({
        accountCode: 'platform_service_income',
        accountType: 'revenue',
        direction: 'debit',
        amountCents: s.serviceFeeCents,
      });
    }
    lines.push({
      accountCode: 'refunds_payable',
      accountType: 'liability',
      direction: 'credit',
      amountCents: s.totalCents,
    });
    if (s.discountCents > 0) {
      lines.push({
        accountCode: 'promo_expense',
        accountType: 'expense',
        direction: 'credit',
        amountCents: s.discountCents,
      });
    }
    return lines;
  }

  // Partial — merchant bears it.
  return [
    {
      accountCode: merchantPayableCode(s.merchantId),
      accountType: 'liability',
      ownerType: 'merchant',
      ownerId: s.merchantId,
      direction: 'debit',
      amountCents,
    },
    {
      accountCode: 'refunds_payable',
      accountType: 'liability',
      direction: 'credit',
      amountCents,
    },
  ];
}

/**
 * Ledger lines for an **auto** refund of an uncaptured-but-collected payment (a late success
 * after a local failure/cancel): the funds really arrived in `mpesa_clearing` but no earnings
 * were ever posted (the order was cancelled), so the inflow is recorded straight into
 * `refunds_payable` to be returned.
 */
export function buildAutoRefundLines(amountCents: number): PostingLine[] {
  return [
    { accountCode: 'mpesa_clearing', accountType: 'asset', direction: 'debit', amountCents },
    { accountCode: 'refunds_payable', accountType: 'liability', direction: 'credit', amountCents },
  ];
}
