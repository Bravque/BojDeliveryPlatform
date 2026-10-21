import type { LedgerRepo } from '../ledger/repo';
import type { AccountType } from '../ledger/accounts';
import type { OrderStatusAggregate, ReportsRepo, RiderUtilization } from './repo';

/**
 * Read-only admin/finance reporting (doc 11). `summary` turns the per-period order/delivery
 * aggregates into business numbers (GMV, volumes, cancel/refund rates, rider utilization);
 * `ledgerOverview` surfaces the ledger as the finance reconciliation view — per-account balances
 * plus the invariant check (`findImbalancedTransactions`). Nothing here writes or moves money.
 */

/** Order statuses that count as a non-completion (for the cancel rate). */
const CANCELLED_STATUSES = new Set(['cancelled', 'rejected']);
const DELIVERED_STATUS = 'delivered';

export interface ReportSummary {
  periodStart: string;
  periodEnd: string;
  gmvCents: number;
  orderCount: number;
  deliveredCount: number;
  cancelledCount: number;
  refundedCount: number;
  /** cancelledCount / orderCount, rounded to 4 dp; 0 when there are no orders. */
  cancelRate: number;
  /** refundedCount / orderCount, rounded to 4 dp; 0 when there are no orders. */
  refundRate: number;
  byStatus: Array<{ status: string; count: number; totalCents: number }>;
  rider: RiderUtilization;
}

export interface LedgerAccountPosition {
  code: string;
  type: AccountType;
  debitCents: number;
  creditCents: number;
  /** Natural positive balance: debit−credit for asset/expense, credit−debit for liability/revenue. */
  balanceCents: number;
}

export interface LedgerOverview {
  generatedAt: string;
  balanced: boolean;
  imbalancedTransactionCount: number;
  accounts: LedgerAccountPosition[];
}

export interface ReportServiceDeps {
  reportsRepo: ReportsRepo;
  ledgerReadRepo: LedgerRepo;
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function naturalBalance(type: AccountType, debitCents: number, creditCents: number): number {
  return type === 'asset' || type === 'expense'
    ? debitCents - creditCents
    : creditCents - debitCents;
}

/** Fold the order-status aggregates into the summary totals. Pure — unit-tested without a DB. */
export function summariseOrders(aggregates: OrderStatusAggregate[]): {
  gmvCents: number;
  orderCount: number;
  deliveredCount: number;
  cancelledCount: number;
} {
  let gmvCents = 0;
  let orderCount = 0;
  let deliveredCount = 0;
  let cancelledCount = 0;
  for (const a of aggregates) {
    orderCount += a.count;
    if (a.status === DELIVERED_STATUS) {
      deliveredCount += a.count;
      gmvCents += a.totalCents;
    }
    if (CANCELLED_STATUSES.has(a.status)) {
      cancelledCount += a.count;
    }
  }
  return { gmvCents, orderCount, deliveredCount, cancelledCount };
}

export function createReportService(deps: ReportServiceDeps) {
  const { reportsRepo, ledgerReadRepo } = deps;

  async function summary(input: {
    periodStart: string;
    periodEnd: string;
  }): Promise<ReportSummary> {
    const [aggregates, refundedCount, rider] = await Promise.all([
      reportsRepo.orderAggregatesForPeriod(input.periodStart, input.periodEnd),
      reportsRepo.refundedOrderCountForPeriod(input.periodStart, input.periodEnd),
      reportsRepo.riderUtilizationForPeriod(input.periodStart, input.periodEnd),
    ]);
    const { gmvCents, orderCount, deliveredCount, cancelledCount } = summariseOrders(aggregates);
    return {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      gmvCents,
      orderCount,
      deliveredCount,
      cancelledCount,
      refundedCount,
      cancelRate: rate(cancelledCount, orderCount),
      refundRate: rate(refundedCount, orderCount),
      byStatus: aggregates
        .map((a) => ({ status: a.status, count: a.count, totalCents: a.totalCents }))
        .sort((x, y) => x.status.localeCompare(y.status)),
      rider,
    };
  }

  async function ledgerOverview(): Promise<LedgerOverview> {
    const [balances, imbalanced] = await Promise.all([
      ledgerReadRepo.getAccountBalances(),
      ledgerReadRepo.findImbalancedTransactions(),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      balanced: imbalanced.length === 0,
      imbalancedTransactionCount: imbalanced.length,
      accounts: balances
        .map((b) => ({
          code: b.code,
          type: b.type,
          debitCents: b.debitCents,
          creditCents: b.creditCents,
          balanceCents: naturalBalance(b.type, b.debitCents, b.creditCents),
        }))
        .sort((x, y) => x.code.localeCompare(y.code)),
    };
  }

  return { summary, ledgerOverview };
}

export type ReportService = ReturnType<typeof createReportService>;
