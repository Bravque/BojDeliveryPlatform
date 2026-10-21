import type { AuditService } from '../auth/audit-service';
import { newUlid } from '../auth/crypto';
import { conflict, notFound, unauthorized } from '../http/errors';
import type { DeliveredOrderRow, SettlementRecord, SettlementsRepo } from './repo';

/** The acting principal (from req.principal). */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface SettlementView {
  ulid: string;
  merchantUlid: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  commissionCents: number;
  refundsCents: number;
  netCents: number;
  status: string;
}

export interface GenerateResult {
  generated: number;
  skipped: number;
  settlements: SettlementView[];
}

export interface SettlementServiceDeps {
  withTransaction: <T>(work: (repo: SettlementsRepo) => Promise<T>) => Promise<T>;
  auditService: AuditService;
}

function toView(s: SettlementRecord): SettlementView {
  return {
    ulid: s.ulid,
    merchantUlid: s.merchantUlid,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    grossCents: s.grossCents,
    commissionCents: s.commissionCents,
    refundsCents: s.refundsCents,
    netCents: s.netCents,
    status: s.status,
  };
}

interface MerchantAgg {
  merchantId: number;
  merchantUlid: string;
  grossCents: number;
  commissionCents: number;
  refundsCents: number;
  netCents: number;
  lines: Array<{
    orderId: number;
    grossCents: number;
    commissionCents: number;
    refundsCents: number;
    netCents: number;
  }>;
}

/** Group delivered-order rows by merchant and compute net = gross − commission − refunds. */
function aggregate(rows: DeliveredOrderRow[]): MerchantAgg[] {
  const byMerchant = new Map<number, MerchantAgg>();
  for (const r of rows) {
    let agg = byMerchant.get(r.merchantId);
    if (!agg) {
      agg = {
        merchantId: r.merchantId,
        merchantUlid: r.merchantUlid,
        grossCents: 0,
        commissionCents: 0,
        refundsCents: 0,
        netCents: 0,
        lines: [],
      };
      byMerchant.set(r.merchantId, agg);
    }
    const lineNet = r.subtotalCents - r.commissionCents - r.refundsCents;
    agg.grossCents += r.subtotalCents;
    agg.commissionCents += r.commissionCents;
    agg.refundsCents += r.refundsCents;
    agg.netCents += lineNet;
    agg.lines.push({
      orderId: r.orderId,
      grossCents: r.subtotalCents,
      commissionCents: r.commissionCents,
      refundsCents: r.refundsCents,
      netCents: lineNet,
    });
  }
  return [...byMerchant.values()];
}

export function createSettlementService(deps: SettlementServiceDeps) {
  const { withTransaction, auditService } = deps;

  /**
   * Generate one draft settlement per merchant for the period, over delivered non-fully-refunded
   * orders. Idempotent: a merchant that already has a settlement for the exact period is skipped
   * (UNIQUE(merchant_id, period_start, period_end) also backs this).
   */
  async function generateSettlements(
    actor: Actor,
    input: { periodStart: string; periodEnd: string },
  ): Promise<GenerateResult> {
    return withTransaction(async (repo) => {
      const rows = await repo.listDeliveredOrdersForPeriod(input.periodStart, input.periodEnd);
      const aggs = aggregate(rows);
      const settlements: SettlementView[] = [];
      let generated = 0;
      let skipped = 0;
      for (const agg of aggs) {
        const existing = await repo.findSettlement(
          agg.merchantId,
          input.periodStart,
          input.periodEnd,
        );
        if (existing) {
          skipped += 1;
          settlements.push(toView(existing));
          continue;
        }
        const ulid = newUlid();
        const settlementId = await repo.insertSettlement({
          ulid,
          merchantId: agg.merchantId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          grossCents: agg.grossCents,
          commissionCents: agg.commissionCents,
          refundsCents: agg.refundsCents,
          netCents: agg.netCents,
        });
        for (const line of agg.lines) {
          await repo.insertSettlementLine({ settlementId, ...line });
        }
        generated += 1;
        settlements.push({
          ulid,
          merchantUlid: agg.merchantUlid,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          grossCents: agg.grossCents,
          commissionCents: agg.commissionCents,
          refundsCents: agg.refundsCents,
          netCents: agg.netCents,
          status: 'draft',
        });
      }
      await auditService.record({
        actorUserId: await repo.findUserIdByUlid(actor.ulid),
        actorRole: actor.roles.includes('admin') ? 'admin' : (actor.roles[0] ?? 'finance'),
        action: 'settlement.generate',
        entityType: 'settlement',
        before: null,
        after: { periodStart: input.periodStart, periodEnd: input.periodEnd, generated, skipped },
      });
      return { generated, skipped, settlements };
    });
  }

  /** Finance/admin approves a draft settlement (statement sign-off; money moves at payout). */
  async function approveSettlement(actor: Actor, ulid: string): Promise<SettlementView> {
    return withTransaction(async (repo) => {
      const settlement = await repo.lockSettlementByUlid(ulid);
      if (!settlement) {
        throw notFound('Settlement not found');
      }
      if (settlement.status !== 'draft') {
        throw conflict('SETTLEMENT_NOT_DRAFT', `Settlement is ${settlement.status}, not draft`);
      }
      const approverId = await repo.findUserIdByUlid(actor.ulid);
      if (approverId === null) {
        throw unauthorized('Unknown principal');
      }
      await repo.setSettlementApproved(settlement.id, approverId);
      await auditService.record({
        actorUserId: approverId,
        actorRole: actor.roles.includes('admin') ? 'admin' : 'finance',
        action: 'settlement.approve',
        entityType: 'settlement',
        entityId: settlement.id,
        before: { status: settlement.status },
        after: { status: 'approved' },
      });
      return toView({ ...settlement, status: 'approved' });
    });
  }

  async function getSettlement(ulid: string): Promise<SettlementView> {
    const settlement = await withTransaction((repo) => repo.findSettlementByUlid(ulid));
    if (!settlement) {
      throw notFound('Settlement not found');
    }
    return toView(settlement);
  }

  async function listSettlements(): Promise<SettlementView[]> {
    const rows = await withTransaction((repo) => repo.listSettlements());
    return rows.map(toView);
  }

  return { generateSettlements, approveSettlement, getSettlement, listSettlements };
}

export type SettlementService = ReturnType<typeof createSettlementService>;
