import { merchantPayableCode, riderPayableCode } from '../ledger/accounts';
import type { PostingLine } from '../ledger/ledger-service';

export type PayeeType = 'merchant' | 'rider';

/**
 * Ledger posting for a completed payout (doc 07 §7, §10): draw the amount down from the payee's
 * payable into `mpesa_clearing` (the cash actually sent out). `DR merchant_payable|rider_payable /
 * CR mpesa_clearing`. Posted once, idempotently (`payout:{id}`), when the B2C result confirms.
 */
export function buildPayoutLines(
  payeeType: PayeeType,
  payeeId: number,
  amountCents: number,
): PostingLine[] {
  const payableCode =
    payeeType === 'merchant' ? merchantPayableCode(payeeId) : riderPayableCode(payeeId);
  return [
    {
      accountCode: payableCode,
      accountType: 'liability',
      ownerType: payeeType,
      ownerId: payeeId,
      direction: 'debit',
      amountCents,
    },
    {
      accountCode: 'mpesa_clearing',
      accountType: 'asset',
      direction: 'credit',
      amountCents,
    },
  ];
}
