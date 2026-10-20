import { describe, expect, it } from 'vitest';
import { riderPayableCode } from '../ledger/accounts';
import { buildRiderEarningsLines } from './earnings';

describe('buildRiderEarningsLines', () => {
  it('reclasses the rider fee from platform_delivery_income to rider_payable (balanced)', () => {
    const lines = buildRiderEarningsLines(42, 7_000);
    const debit = lines
      .filter((l) => l.direction === 'debit')
      .reduce((s, l) => s + l.amountCents, 0);
    const credit = lines
      .filter((l) => l.direction === 'credit')
      .reduce((s, l) => s + l.amountCents, 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(7_000);

    const debitLine = lines.find((l) => l.direction === 'debit');
    const creditLine = lines.find((l) => l.direction === 'credit');
    expect(debitLine?.accountCode).toBe('platform_delivery_income');
    expect(creditLine?.accountCode).toBe(riderPayableCode(42));
    expect(creditLine?.ownerType).toBe('rider');
  });
});
