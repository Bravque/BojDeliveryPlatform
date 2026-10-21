import { describe, expect, it } from 'vitest';
import { merchantPayableCode, riderPayableCode } from '../ledger/accounts';
import { buildPayoutLines } from './payout';

describe('buildPayoutLines', () => {
  it('draws a merchant payout down from merchant_payable into mpesa_clearing (balanced)', () => {
    const lines = buildPayoutLines('merchant', 5, 40_000);
    const debit = lines.find((l) => l.direction === 'debit');
    const credit = lines.find((l) => l.direction === 'credit');
    expect(debit).toMatchObject({ accountCode: merchantPayableCode(5), amountCents: 40_000 });
    expect(credit).toMatchObject({ accountCode: 'mpesa_clearing', amountCents: 40_000 });
  });

  it('draws a rider payout down from rider_payable', () => {
    const lines = buildPayoutLines('rider', 9, 14_000);
    expect(lines.find((l) => l.direction === 'debit')?.accountCode).toBe(riderPayableCode(9));
    const debit = lines
      .filter((l) => l.direction === 'debit')
      .reduce((s, l) => s + l.amountCents, 0);
    const credit = lines
      .filter((l) => l.direction === 'credit')
      .reduce((s, l) => s + l.amountCents, 0);
    expect(debit).toBe(credit);
  });
});
