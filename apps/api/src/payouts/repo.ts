import type { Knex } from 'knex';
import type { PayeeType } from './payout';

/**
 * Persistence for payouts. Executor-bound so generation/approval/execution can run in one
 * transaction with the ledger. Generation reads approved settlements (merchant payouts) and
 * delivered rider fees (rider payouts); the lifecycle mirrors refunds (dual-sign → execute → confirm).
 */

export type PayoutStatus = 'draft' | 'approved' | 'processing' | 'paid' | 'failed';

export interface PayoutRecord {
  id: number;
  ulid: string;
  payeeType: PayeeType;
  payeeId: number;
  amountCents: number;
  status: PayoutStatus;
  externalRef: string | null;
  idempotencyKey: string;
  financeApprovedBy: number | null;
  opsApprovedBy: number | null;
}

export interface ApprovedSettlementRow {
  settlementId: number;
  merchantId: number;
  netCents: number;
}

export interface RiderEarningRow {
  riderId: number;
  deliveryId: number;
  riderFeeCents: number;
}

export interface InsertPayoutInput {
  ulid: string;
  payeeType: PayeeType;
  payeeId: number;
  amountCents: number;
  idempotencyKey: string;
}

export interface PayoutsRepo {
  findUserIdByUlid(ulid: string): Promise<number | null>;
  listApprovedSettlementsForPeriod(
    periodStart: string,
    periodEnd: string,
  ): Promise<ApprovedSettlementRow[]>;
  /** Delivered deliveries in [periodStart, periodEnd] with a rider + a fee (for rider payouts). */
  listRiderEarningsForPeriod(periodStart: string, periodEnd: string): Promise<RiderEarningRow[]>;
  findPayoutByIdempotencyKey(key: string): Promise<PayoutRecord | null>;
  insertPayout(input: InsertPayoutInput): Promise<number>;
  insertPayoutLine(input: {
    payoutId: number;
    refType: 'settlement' | 'delivery';
    refId: number;
    amountCents: number;
  }): Promise<void>;
  findPayoutByUlid(ulid: string): Promise<PayoutRecord | null>;
  lockPayoutByUlid(ulid: string): Promise<PayoutRecord | null>;
  /** Load + lock a payout by its provider conversation id (B2C `external_ref`). */
  lockPayoutByExternalRef(externalRef: string): Promise<PayoutRecord | null>;
  /** Payee M-Pesa MSISDN: rider → user phone; merchant → not modelled yet (null). */
  getPayeeMsisdn(payeeType: PayeeType, payeeId: number): Promise<string | null>;
  /** Persist a raw B2C result event; returns false when `dedupeKey` already exists (replay). */
  insertPayoutEventDedup(input: {
    payoutId: number | null;
    source: 'b2c_result' | 'b2c_timeout' | 'manual';
    dedupeKey: string;
    resultCode: number | null;
    rawPayload: unknown;
  }): Promise<boolean>;
  setFinanceApprover(payoutId: number, userId: number): Promise<void>;
  setOpsApprover(payoutId: number, userId: number): Promise<void>;
  setPayoutApproved(payoutId: number): Promise<void>;
  setPayoutProcessing(payoutId: number, externalRef: string): Promise<void>;
  setPayoutPaid(payoutId: number): Promise<void>;
  setPayoutFailed(payoutId: number): Promise<void>;
  /** Settlement ids referenced by a payout's lines (to mark them paid on success). */
  settlementRefsForPayout(payoutId: number): Promise<number[]>;
  markSettlementsPaid(settlementIds: number[]): Promise<void>;
  listPayouts(): Promise<PayoutRecord[]>;
}

interface PayoutRowDb {
  id: number | string;
  ulid: string;
  payee_type: PayeeType;
  payee_id: number | string;
  amount_cents: number | string;
  status: PayoutStatus;
  external_ref: string | null;
  idempotency_key: string;
  finance_approved_by: number | string | null;
  ops_approved_by: number | string | null;
}

function mapPayout(row: PayoutRowDb): PayoutRecord {
  return {
    id: Number(row.id),
    ulid: row.ulid,
    payeeType: row.payee_type,
    payeeId: Number(row.payee_id),
    amountCents: Number(row.amount_cents),
    status: row.status,
    externalRef: row.external_ref,
    idempotencyKey: row.idempotency_key,
    financeApprovedBy: row.finance_approved_by === null ? null : Number(row.finance_approved_by),
    opsApprovedBy: row.ops_approved_by === null ? null : Number(row.ops_approved_by),
  };
}

export function createKnexPayoutsRepo(exec: Knex): PayoutsRepo {
  return {
    async findUserIdByUlid(ulid) {
      const row = (await exec('user').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async listApprovedSettlementsForPeriod(periodStart, periodEnd) {
      const rows = (await exec('settlement')
        .where('status', 'approved')
        .where('period_start', '>=', periodStart)
        .where('period_end', '<=', periodEnd)
        .orderBy('id', 'asc')
        .select('id', 'merchant_id', 'net_cents')) as Array<{
        id: number | string;
        merchant_id: number | string;
        net_cents: number | string;
      }>;
      return rows.map((r) => ({
        settlementId: Number(r.id),
        merchantId: Number(r.merchant_id),
        netCents: Number(r.net_cents),
      }));
    },

    async listRiderEarningsForPeriod(periodStart, periodEnd) {
      const rows = (await exec('delivery')
        .where('status', 'delivered')
        .whereNotNull('rider_id')
        .where('delivered_at', '>=', periodStart)
        .where('delivered_at', '<', exec.raw('DATE_ADD(?, INTERVAL 1 DAY)', [periodEnd]))
        .orderBy('rider_id', 'asc')
        .select('id', 'rider_id', 'rider_fee_cents')) as Array<{
        id: number | string;
        rider_id: number | string;
        rider_fee_cents: number | string;
      }>;
      return rows.map((r) => ({
        riderId: Number(r.rider_id),
        deliveryId: Number(r.id),
        riderFeeCents: Number(r.rider_fee_cents),
      }));
    },

    async findPayoutByIdempotencyKey(key) {
      const row = (await exec('payout').where({ idempotency_key: key }).first()) as
        PayoutRowDb | undefined;
      return row ? mapPayout(row) : null;
    },

    async insertPayout(input) {
      const [id] = await exec('payout').insert({
        ulid: input.ulid,
        payee_type: input.payeeType,
        payee_id: input.payeeId,
        amount_cents: input.amountCents,
        idempotency_key: input.idempotencyKey,
      });
      return Number(id);
    },

    async insertPayoutLine(input) {
      await exec('payout_line').insert({
        payout_id: input.payoutId,
        ref_type: input.refType,
        ref_id: input.refId,
        amount_cents: input.amountCents,
      });
    },

    async findPayoutByUlid(ulid) {
      const row = (await exec('payout').where({ ulid }).first()) as PayoutRowDb | undefined;
      return row ? mapPayout(row) : null;
    },

    async lockPayoutByUlid(ulid) {
      const row = (await exec('payout').where({ ulid }).forUpdate().first()) as
        PayoutRowDb | undefined;
      return row ? mapPayout(row) : null;
    },

    async lockPayoutByExternalRef(externalRef) {
      const row = (await exec('payout')
        .where({ external_ref: externalRef })
        .forUpdate()
        .first()) as PayoutRowDb | undefined;
      return row ? mapPayout(row) : null;
    },

    async getPayeeMsisdn(payeeType, payeeId) {
      // Rider payee_id = rider_profile.user_id = user.id → the rider's M-Pesa number.
      // Merchant payout destinations are not modelled yet (settled off-platform / future field).
      if (payeeType !== 'rider') {
        return null;
      }
      const row = (await exec('user').where({ id: payeeId }).first('phone_e164')) as
        { phone_e164: string } | undefined;
      return row?.phone_e164 ?? null;
    },

    async insertPayoutEventDedup(input) {
      const inserted = await exec('payout_event')
        .insert({
          payout_id: input.payoutId,
          source: input.source,
          dedupe_key: input.dedupeKey,
          result_code: input.resultCode,
          raw_payload: JSON.stringify(input.rawPayload),
        })
        .onConflict('dedupe_key')
        .ignore();
      const affected = Array.isArray(inserted) ? (inserted[0] ?? 0) : inserted;
      return Number(affected) > 0;
    },

    async setFinanceApprover(payoutId, userId) {
      await exec('payout').where({ id: payoutId }).update({ finance_approved_by: userId });
    },

    async setOpsApprover(payoutId, userId) {
      await exec('payout').where({ id: payoutId }).update({ ops_approved_by: userId });
    },

    async setPayoutApproved(payoutId) {
      await exec('payout').where({ id: payoutId }).update({ status: 'approved' });
    },

    async setPayoutProcessing(payoutId, externalRef) {
      await exec('payout')
        .where({ id: payoutId })
        .update({ status: 'processing', external_ref: externalRef });
    },

    async setPayoutPaid(payoutId) {
      await exec('payout')
        .where({ id: payoutId })
        .update({ status: 'paid', paid_at: exec.raw('CURRENT_TIMESTAMP(3)') });
    },

    async setPayoutFailed(payoutId) {
      await exec('payout').where({ id: payoutId }).update({ status: 'failed' });
    },

    async settlementRefsForPayout(payoutId) {
      const rows = (await exec('payout_line')
        .where({ payout_id: payoutId, ref_type: 'settlement' })
        .select('ref_id')) as Array<{ ref_id: number | string }>;
      return rows.map((r) => Number(r.ref_id));
    },

    async markSettlementsPaid(settlementIds) {
      if (settlementIds.length === 0) {
        return;
      }
      await exec('settlement').whereIn('id', settlementIds).update({ status: 'paid' });
    },

    async listPayouts() {
      const rows = (await exec('payout').orderBy('id', 'desc')) as PayoutRowDb[];
      return rows.map(mapPayout);
    },
  };
}
