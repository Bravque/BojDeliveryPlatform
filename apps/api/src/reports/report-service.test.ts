import { describe, expect, it } from 'vitest';
import type { AccountBalance, LedgerRepo } from '../ledger/repo';
import { createReportService, summariseOrders } from './report-service';
import type { OrderStatusAggregate, ReportsRepo, RiderUtilization } from './repo';

function reportsRepo(opts: {
  aggregates?: OrderStatusAggregate[];
  refunded?: number;
  rider?: RiderUtilization;
}): ReportsRepo {
  return {
    orderAggregatesForPeriod: () => Promise.resolve(opts.aggregates ?? []),
    refundedOrderCountForPeriod: () => Promise.resolve(opts.refunded ?? 0),
    riderUtilizationForPeriod: () =>
      Promise.resolve(opts.rider ?? { activeRiders: 0, deliveries: 0, feesCents: 0 }),
  };
}

function ledgerRepo(balances: AccountBalance[], imbalanced: number[] = []): LedgerRepo {
  return {
    getAccountBalances: () => Promise.resolve(balances),
    findImbalancedTransactions: () => Promise.resolve(imbalanced),
  } as unknown as LedgerRepo;
}

const period = { periodStart: '2026-10-01', periodEnd: '2026-10-07' };

describe('summariseOrders (pure)', () => {
  it('sums GMV from delivered orders and counts cancellations (cancelled + rejected)', () => {
    const r = summariseOrders([
      { status: 'delivered', count: 8, totalCents: 400_000 },
      { status: 'cancelled', count: 1, totalCents: 5_000 },
      { status: 'rejected', count: 1, totalCents: 6_000 },
      { status: 'placed', count: 2, totalCents: 20_000 },
    ]);
    expect(r).toEqual({
      gmvCents: 400_000,
      orderCount: 12,
      deliveredCount: 8,
      cancelledCount: 2,
    });
  });
});

describe('report service — summary', () => {
  it('computes GMV, volumes, cancel/refund rates and rider utilization', async () => {
    const svc = createReportService({
      reportsRepo: reportsRepo({
        aggregates: [
          { status: 'delivered', count: 8, totalCents: 400_000 },
          { status: 'cancelled', count: 2, totalCents: 10_000 },
        ],
        refunded: 1,
        rider: { activeRiders: 3, deliveries: 8, feesCents: 56_000 },
      }),
      ledgerReadRepo: ledgerRepo([]),
    });
    const s = await svc.summary(period);
    expect(s.gmvCents).toBe(400_000);
    expect(s.orderCount).toBe(10);
    expect(s.deliveredCount).toBe(8);
    expect(s.cancelledCount).toBe(2);
    expect(s.cancelRate).toBe(0.2);
    expect(s.refundedCount).toBe(1);
    expect(s.refundRate).toBe(0.1);
    expect(s.rider).toEqual({ activeRiders: 3, deliveries: 8, feesCents: 56_000 });
    expect(s.byStatus.map((b) => b.status)).toEqual(['cancelled', 'delivered']); // sorted
  });

  it('reports zero rates (not NaN) when there are no orders', async () => {
    const svc = createReportService({
      reportsRepo: reportsRepo({}),
      ledgerReadRepo: ledgerRepo([]),
    });
    const s = await svc.summary(period);
    expect(s.orderCount).toBe(0);
    expect(s.cancelRate).toBe(0);
    expect(s.refundRate).toBe(0);
  });
});

describe('report service — ledger overview', () => {
  it('reports natural balances per account and the invariant flag', async () => {
    const svc = createReportService({
      reportsRepo: reportsRepo({}),
      ledgerReadRepo: ledgerRepo([
        { code: 'mpesa_clearing', type: 'asset', debitCents: 100_000, creditCents: 40_000 },
        { code: 'merchant_payable:1', type: 'liability', debitCents: 0, creditCents: 27_000 },
        { code: 'commission_revenue', type: 'revenue', debitCents: 0, creditCents: 3_000 },
      ]),
    });
    const o = await svc.ledgerOverview();
    expect(o.balanced).toBe(true);
    expect(o.imbalancedTransactionCount).toBe(0);
    const byCode = Object.fromEntries(o.accounts.map((a) => [a.code, a.balanceCents]));
    expect(byCode['mpesa_clearing']).toBe(60_000); // asset: debit − credit
    expect(byCode['merchant_payable:1']).toBe(27_000); // liability: credit − debit
    expect(byCode['commission_revenue']).toBe(3_000); // revenue: credit − debit
  });

  it('flags an imbalanced ledger', async () => {
    const svc = createReportService({
      reportsRepo: reportsRepo({}),
      ledgerReadRepo: ledgerRepo([], [42]),
    });
    const o = await svc.ledgerOverview();
    expect(o.balanced).toBe(false);
    expect(o.imbalancedTransactionCount).toBe(1);
  });
});
