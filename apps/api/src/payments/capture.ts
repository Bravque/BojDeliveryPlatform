import { merchantPayableCode } from '../ledger/accounts';
import type { PostingLine } from '../ledger/ledger-service';

/**
 * Normalised STK result (a provider adapter maps the raw Daraja callback to this). `resultCode` 0
 * means success; `amountCents`/`mpesaReceipt` are present on success.
 */
export interface StkCallback {
  checkoutRequestId: string;
  merchantRequestId?: string | null;
  resultCode: number;
  resultDesc: string;
  amountCents?: number | null;
  mpesaReceipt?: string | null;
}

export type CaptureOutcome =
  | 'captured'
  | 'failed'
  | 'duplicate'
  | 'unknown_payment'
  | 'already_final'
  | 'amount_mismatch'
  | 'auto_refunded';

/** The order money snapshot needed to post the capture. */
export interface OrderMoneySnapshot {
  id: number;
  merchantId: number;
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  discountCents: number;
  totalCents: number;
  commissionCents: number;
}

/**
 * Platform-funded (D4) capture posting: the merchant is paid on the full subtotal (minus
 * commission); the platform absorbs the discount to `promo_expense`. Debits (total + discount)
 * equal credits (subtotal + delivery + service).
 */
export function buildCaptureLines(s: OrderMoneySnapshot): PostingLine[] {
  const lines: PostingLine[] = [
    {
      accountCode: 'mpesa_clearing',
      accountType: 'asset',
      direction: 'debit',
      amountCents: s.totalCents,
    },
  ];
  if (s.discountCents > 0) {
    lines.push({
      accountCode: 'promo_expense',
      accountType: 'expense',
      direction: 'debit',
      amountCents: s.discountCents,
    });
  }
  lines.push({
    accountCode: merchantPayableCode(s.merchantId),
    accountType: 'liability',
    ownerType: 'merchant',
    ownerId: s.merchantId,
    direction: 'credit',
    amountCents: s.subtotalCents - s.commissionCents,
  });
  lines.push({
    accountCode: 'commission_revenue',
    accountType: 'revenue',
    direction: 'credit',
    amountCents: s.commissionCents,
  });
  if (s.deliveryFeeCents > 0) {
    lines.push({
      accountCode: 'platform_delivery_income',
      accountType: 'revenue',
      direction: 'credit',
      amountCents: s.deliveryFeeCents,
    });
  }
  if (s.serviceFeeCents > 0) {
    lines.push({
      accountCode: 'platform_service_income',
      accountType: 'revenue',
      direction: 'credit',
      amountCents: s.serviceFeeCents,
    });
  }
  return lines;
}
