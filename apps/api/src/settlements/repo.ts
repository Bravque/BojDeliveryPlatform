import type { Knex } from 'knex';

/**
 * Persistence for merchant settlements. Executor-bound so generation + approval can run in one
 * transaction. The core read aggregates **delivered, non-fully-refunded** orders per merchant over a
 * period, with each order's completed-refund total (partial refunds are merchant-borne, D14).
 */

export type SettlementStatus = 'draft' | 'approved' | 'paid' | 'failed';

/** One delivered order's contribution to a settlement (refundsCents = completed refunds on it). */
export interface DeliveredOrderRow {
  merchantId: number;
  merchantUlid: string;
  orderId: number;
  subtotalCents: number;
  commissionCents: number;
  refundsCents: number;
}

export interface SettlementRecord {
  id: number;
  ulid: string;
  merchantId: number;
  merchantUlid: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  commissionCents: number;
  refundsCents: number;
  netCents: number;
  status: SettlementStatus;
  approvedBy: number | null;
}

export interface InsertSettlementInput {
  ulid: string;
  merchantId: number;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  commissionCents: number;
  refundsCents: number;
  netCents: number;
}

export interface SettlementsRepo {
  findUserIdByUlid(ulid: string): Promise<number | null>;
  /** Delivered, non-fully-refunded orders in [periodStart, periodEnd] (by delivery.delivered_at). */
  listDeliveredOrdersForPeriod(
    periodStart: string,
    periodEnd: string,
  ): Promise<DeliveredOrderRow[]>;
  findSettlement(
    merchantId: number,
    periodStart: string,
    periodEnd: string,
  ): Promise<SettlementRecord | null>;
  insertSettlement(input: InsertSettlementInput): Promise<number>;
  insertSettlementLine(input: {
    settlementId: number;
    orderId: number;
    grossCents: number;
    commissionCents: number;
    refundsCents: number;
    netCents: number;
  }): Promise<void>;
  findSettlementByUlid(ulid: string): Promise<SettlementRecord | null>;
  /** Load a settlement inside a transaction, locking the row (FOR UPDATE). */
  lockSettlementByUlid(ulid: string): Promise<SettlementRecord | null>;
  setSettlementApproved(settlementId: number, approvedBy: number): Promise<void>;
  listSettlements(): Promise<SettlementRecord[]>;
}

interface SettlementRowDb {
  id: number | string;
  ulid: string;
  merchant_id: number | string;
  merchant_ulid: string;
  period_start: string | Date;
  period_end: string | Date;
  gross_cents: number | string;
  commission_cents: number | string;
  refunds_cents: number | string;
  net_cents: number | string;
  status: SettlementStatus;
  approved_by: number | string | null;
}

function toDateString(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function mapSettlement(row: SettlementRowDb): SettlementRecord {
  return {
    id: Number(row.id),
    ulid: row.ulid,
    merchantId: Number(row.merchant_id),
    merchantUlid: row.merchant_ulid,
    periodStart: toDateString(row.period_start),
    periodEnd: toDateString(row.period_end),
    grossCents: Number(row.gross_cents),
    commissionCents: Number(row.commission_cents),
    refundsCents: Number(row.refunds_cents),
    netCents: Number(row.net_cents),
    status: row.status,
    approvedBy: row.approved_by === null ? null : Number(row.approved_by),
  };
}

const SETTLEMENT_COLUMNS = [
  'settlement.id',
  'settlement.ulid',
  'settlement.merchant_id',
  'merchant.ulid as merchant_ulid',
  'settlement.period_start',
  'settlement.period_end',
  'settlement.gross_cents',
  'settlement.commission_cents',
  'settlement.refunds_cents',
  'settlement.net_cents',
  'settlement.status',
  'settlement.approved_by',
];

export function createKnexSettlementsRepo(exec: Knex): SettlementsRepo {
  return {
    async findUserIdByUlid(ulid) {
      const row = (await exec('user').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async listDeliveredOrdersForPeriod(periodStart, periodEnd) {
      const rows = (await exec('order')
        .join('delivery', 'delivery.order_id', 'order.id')
        .join('merchant', 'merchant.id', 'order.merchant_id')
        .leftJoin(
          exec.raw(
            '(SELECT order_id, SUM(amount_cents) AS refunds_cents FROM refund WHERE status = ? GROUP BY order_id) AS rf',
            ['completed'],
          ),
          'rf.order_id',
          'order.id',
        )
        .where('order.status', 'delivered')
        .whereIn('order.payment_status', ['paid', 'partially_refunded'])
        .where('delivery.delivered_at', '>=', periodStart)
        .where('delivery.delivered_at', '<', exec.raw('DATE_ADD(?, INTERVAL 1 DAY)', [periodEnd]))
        .orderBy('order.merchant_id', 'asc')
        .select(
          'order.id as order_id',
          'order.merchant_id as merchant_id',
          'merchant.ulid as merchant_ulid',
          'order.subtotal_cents as subtotal_cents',
          'order.commission_cents as commission_cents',
          exec.raw('COALESCE(rf.refunds_cents, 0) as refunds_cents'),
        )) as Array<{
        order_id: number | string;
        merchant_id: number | string;
        merchant_ulid: string;
        subtotal_cents: number | string;
        commission_cents: number | string;
        refunds_cents: number | string;
      }>;
      return rows.map((r) => ({
        orderId: Number(r.order_id),
        merchantId: Number(r.merchant_id),
        merchantUlid: r.merchant_ulid,
        subtotalCents: Number(r.subtotal_cents),
        commissionCents: Number(r.commission_cents),
        refundsCents: Number(r.refunds_cents),
      }));
    },

    async findSettlement(merchantId, periodStart, periodEnd) {
      const row = (await exec('settlement')
        .join('merchant', 'merchant.id', 'settlement.merchant_id')
        .where({
          'settlement.merchant_id': merchantId,
          'settlement.period_start': periodStart,
          'settlement.period_end': periodEnd,
        })
        .first(SETTLEMENT_COLUMNS)) as SettlementRowDb | undefined;
      return row ? mapSettlement(row) : null;
    },

    async insertSettlement(input) {
      const [id] = await exec('settlement').insert({
        ulid: input.ulid,
        merchant_id: input.merchantId,
        period_start: input.periodStart,
        period_end: input.periodEnd,
        gross_cents: input.grossCents,
        commission_cents: input.commissionCents,
        refunds_cents: input.refundsCents,
        net_cents: input.netCents,
      });
      return Number(id);
    },

    async insertSettlementLine(input) {
      await exec('settlement_line').insert({
        settlement_id: input.settlementId,
        order_id: input.orderId,
        gross_cents: input.grossCents,
        commission_cents: input.commissionCents,
        refunds_cents: input.refundsCents,
        net_cents: input.netCents,
      });
    },

    async findSettlementByUlid(ulid) {
      const row = (await exec('settlement')
        .join('merchant', 'merchant.id', 'settlement.merchant_id')
        .where('settlement.ulid', ulid)
        .first(SETTLEMENT_COLUMNS)) as SettlementRowDb | undefined;
      return row ? mapSettlement(row) : null;
    },

    async lockSettlementByUlid(ulid) {
      const row = (await exec('settlement')
        .join('merchant', 'merchant.id', 'settlement.merchant_id')
        .where('settlement.ulid', ulid)
        .forUpdate('settlement')
        .first(SETTLEMENT_COLUMNS)) as SettlementRowDb | undefined;
      return row ? mapSettlement(row) : null;
    },

    async setSettlementApproved(settlementId, approvedBy) {
      await exec('settlement')
        .where({ id: settlementId })
        .update({
          status: 'approved',
          approved_by: approvedBy,
          approved_at: exec.raw('CURRENT_TIMESTAMP(3)'),
        });
    },

    async listSettlements() {
      const rows = (await exec('settlement')
        .join('merchant', 'merchant.id', 'settlement.merchant_id')
        .orderBy('settlement.id', 'desc')
        .select(SETTLEMENT_COLUMNS)) as SettlementRowDb[];
      return rows.map(mapSettlement);
    },
  };
}
