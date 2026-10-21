import type { Knex } from 'knex';

/**
 * Read-only reporting aggregates (doc 11 — admin/reporting). Pure SELECTs over orders + deliveries
 * for a period; no writes, no money movement. The finance/ledger overview reads the ledger via the
 * existing `LedgerRepo` (`getAccountBalances` + `findImbalancedTransactions`), so this repo covers
 * only the operational order/delivery numbers. All period bounds are inclusive dates
 * `[periodStart, periodEnd]` (resolved to `< periodEnd + 1 day` on the timestamp columns).
 */

/** One order-status bucket over the period (volume + gross value). */
export interface OrderStatusAggregate {
  status: string;
  count: number;
  totalCents: number;
}

/** Rider activity over the period, from delivered deliveries. */
export interface RiderUtilization {
  activeRiders: number;
  deliveries: number;
  feesCents: number;
}

export interface ReportsRepo {
  /** Orders by fulfilment status, counted + summed by `order.created_at` in the period. */
  orderAggregatesForPeriod(periodStart: string, periodEnd: string): Promise<OrderStatusAggregate[]>;
  /** Orders whose payment was refunded/partially refunded, by `order.created_at` in the period. */
  refundedOrderCountForPeriod(periodStart: string, periodEnd: string): Promise<number>;
  /** Distinct riders, delivered count, and total rider fees over `delivery.delivered_at` in period. */
  riderUtilizationForPeriod(periodStart: string, periodEnd: string): Promise<RiderUtilization>;
}

export function createKnexReportsRepo(exec: Knex): ReportsRepo {
  const endExclusive = (periodEnd: string) => exec.raw('DATE_ADD(?, INTERVAL 1 DAY)', [periodEnd]);

  return {
    async orderAggregatesForPeriod(periodStart, periodEnd) {
      const rows = (await exec('order')
        .where('created_at', '>=', periodStart)
        .where('created_at', '<', endExclusive(periodEnd))
        .groupBy('status')
        .select('status')
        .select(exec.raw('COUNT(*) as cnt'))
        .select(exec.raw('COALESCE(SUM(total_cents), 0) as total_cents'))) as Array<{
        status: string;
        cnt: number | string;
        total_cents: number | string;
      }>;
      return rows.map((r) => ({
        status: r.status,
        count: Number(r.cnt),
        totalCents: Number(r.total_cents),
      }));
    },

    async refundedOrderCountForPeriod(periodStart, periodEnd) {
      const row = (await exec('order')
        .whereIn('payment_status', ['refunded', 'partially_refunded'])
        .where('created_at', '>=', periodStart)
        .where('created_at', '<', endExclusive(periodEnd))
        .count({ cnt: '*' })
        .first()) as { cnt: number | string } | undefined;
      return Number(row?.cnt ?? 0);
    },

    async riderUtilizationForPeriod(periodStart, periodEnd) {
      const row = (await exec('delivery')
        .where('status', 'delivered')
        .whereNotNull('rider_id')
        .where('delivered_at', '>=', periodStart)
        .where('delivered_at', '<', endExclusive(periodEnd))
        .select(exec.raw('COUNT(*) as deliveries'))
        .select(exec.raw('COUNT(DISTINCT rider_id) as active_riders'))
        .select(exec.raw('COALESCE(SUM(rider_fee_cents), 0) as fees_cents'))
        .first()) as
        | {
            deliveries: number | string;
            active_riders: number | string;
            fees_cents: number | string;
          }
        | undefined;
      return {
        deliveries: Number(row?.deliveries ?? 0),
        activeRiders: Number(row?.active_riders ?? 0),
        feesCents: Number(row?.fees_cents ?? 0),
      };
    },
  };
}
