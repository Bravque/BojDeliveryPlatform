import { riderPayableCode } from '../ledger/accounts';
import type { PostingLine } from '../ledger/ledger-service';

/**
 * Rider-earnings accrual on delivery (doc 07 §7, §10). The customer's delivery fee was credited to
 * `platform_delivery_income` at capture; on `delivered` the rider's snapshotted fee is reclassed
 * from there into `rider_payable:{riderId}`, leaving the platform margin (D15) in
 * `platform_delivery_income`. Settled to the rider at payout (Phase 7).
 */
export function buildRiderEarningsLines(riderId: number, riderFeeCents: number): PostingLine[] {
  return [
    {
      accountCode: 'platform_delivery_income',
      accountType: 'revenue',
      direction: 'debit',
      amountCents: riderFeeCents,
    },
    {
      accountCode: riderPayableCode(riderId),
      accountType: 'liability',
      ownerType: 'rider',
      ownerId: riderId,
      direction: 'credit',
      amountCents: riderFeeCents,
    },
  ];
}
