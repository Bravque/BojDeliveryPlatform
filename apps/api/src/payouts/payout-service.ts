import type { AuditService } from '../auth/audit-service';
import { newUlid } from '../auth/crypto';
import { conflict, forbidden, notFound, unauthorized } from '../http/errors';
import type { LedgerRepo } from '../ledger/repo';
import type { LedgerService } from '../ledger/ledger-service';
import type { PayoutGateway } from './gateway';
import { buildPayoutLines } from './payout';
import type { PayoutRecord, PayoutsRepo } from './repo';

/** The acting principal (from req.principal). */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface PayoutView {
  ulid: string;
  payeeType: string;
  amountCents: number;
  status: string;
  financeApproved: boolean;
  opsApproved: boolean;
  externalRef: string | null;
}

export interface GeneratePayoutsResult {
  generated: number;
  skipped: number;
  payouts: PayoutView[];
}

export type ConfirmOutcome = 'paid' | 'failed' | 'already_final';

export interface PayoutRepos {
  payouts: PayoutsRepo;
  ledger: LedgerRepo;
}

export interface PayoutServiceDeps {
  withTransaction: <T>(work: (repos: PayoutRepos) => Promise<T>) => Promise<T>;
  ledgerService: LedgerService;
  gateway: PayoutGateway;
  auditService: AuditService;
}

function toView(p: PayoutRecord): PayoutView {
  return {
    ulid: p.ulid,
    payeeType: p.payeeType,
    amountCents: p.amountCents,
    status: p.status,
    financeApproved: p.financeApprovedBy !== null,
    opsApproved: p.opsApprovedBy !== null,
    externalRef: p.externalRef,
  };
}

export function createPayoutService(deps: PayoutServiceDeps) {
  const { withTransaction, ledgerService, gateway, auditService } = deps;

  function actorRole(actor: Actor): string {
    return actor.roles.includes('admin') ? 'admin' : (actor.roles[0] ?? 'unknown');
  }

  /**
   * Draft payouts for a period: one merchant payout per approved settlement, and one rider payout
   * per rider from their delivered fees. Idempotent — an existing payout for the same source
   * (idempotency key) is skipped. Zero-amount payees are skipped.
   */
  async function generatePayouts(
    actor: Actor,
    input: { periodStart: string; periodEnd: string },
  ): Promise<GeneratePayoutsResult> {
    return withTransaction(async ({ payouts }) => {
      const views: PayoutView[] = [];
      let generated = 0;
      let skipped = 0;

      const makePayout = async (
        payeeType: 'merchant' | 'rider',
        payeeId: number,
        amountCents: number,
        idempotencyKey: string,
        lines: Array<{ refType: 'settlement' | 'delivery'; refId: number; amountCents: number }>,
      ): Promise<void> => {
        if (amountCents <= 0) {
          return;
        }
        if (await payouts.findPayoutByIdempotencyKey(idempotencyKey)) {
          skipped += 1;
          return;
        }
        const ulid = newUlid();
        const payoutId = await payouts.insertPayout({
          ulid,
          payeeType,
          payeeId,
          amountCents,
          idempotencyKey,
        });
        for (const line of lines) {
          await payouts.insertPayoutLine({ payoutId, ...line });
        }
        generated += 1;
        views.push({
          ulid,
          payeeType,
          amountCents,
          status: 'draft',
          financeApproved: false,
          opsApproved: false,
          externalRef: null,
        });
      };

      // Merchant payouts — one per approved settlement in the period.
      for (const s of await payouts.listApprovedSettlementsForPeriod(
        input.periodStart,
        input.periodEnd,
      )) {
        await makePayout('merchant', s.merchantId, s.netCents, `settlement:${s.settlementId}`, [
          { refType: 'settlement', refId: s.settlementId, amountCents: s.netCents },
        ]);
      }

      // Rider payouts — aggregate delivered fees per rider in the period.
      const byRider = new Map<
        number,
        { total: number; lines: Array<{ refType: 'delivery'; refId: number; amountCents: number }> }
      >();
      for (const e of await payouts.listRiderEarningsForPeriod(
        input.periodStart,
        input.periodEnd,
      )) {
        const agg = byRider.get(e.riderId) ?? { total: 0, lines: [] };
        agg.total += e.riderFeeCents;
        agg.lines.push({ refType: 'delivery', refId: e.deliveryId, amountCents: e.riderFeeCents });
        byRider.set(e.riderId, agg);
      }
      for (const [riderId, agg] of byRider) {
        await makePayout(
          'rider',
          riderId,
          agg.total,
          `rider:${riderId}:${input.periodStart}:${input.periodEnd}`,
          agg.lines,
        );
      }

      await auditService.record({
        actorUserId: await payouts.findUserIdByUlid(actor.ulid),
        actorRole: actorRole(actor),
        action: 'payout.generate',
        entityType: 'payout',
        before: null,
        after: { periodStart: input.periodStart, periodEnd: input.periodEnd, generated, skipped },
      });
      return { generated, skipped, payouts: views };
    });
  }

  async function approve(actor: Actor, ulid: string, side: 'finance' | 'ops'): Promise<PayoutView> {
    return withTransaction(async ({ payouts }) => {
      const payout = await payouts.lockPayoutByUlid(ulid);
      if (!payout) {
        throw notFound('Payout not found');
      }
      if (payout.status !== 'draft') {
        throw conflict('PAYOUT_NOT_DRAFT', `Payout is ${payout.status}, not draft`);
      }
      const userId = await payouts.findUserIdByUlid(actor.ulid);
      if (userId === null) {
        throw unauthorized('Unknown principal');
      }
      const mine = side === 'finance' ? payout.financeApprovedBy : payout.opsApprovedBy;
      const other = side === 'finance' ? payout.opsApprovedBy : payout.financeApprovedBy;
      if (mine !== null) {
        throw conflict('ALREADY_APPROVED', `Payout already has a ${side} approval`);
      }
      if (other === userId) {
        throw forbidden('Separation of duties: finance and ops approvers must differ');
      }
      if (side === 'finance') {
        await payouts.setFinanceApprover(payout.id, userId);
      } else {
        await payouts.setOpsApprover(payout.id, userId);
      }
      const bothApproved = other !== null; // the other side was already set → now both are
      if (bothApproved) {
        await payouts.setPayoutApproved(payout.id);
      }
      await auditService.record({
        actorUserId: userId,
        actorRole: actorRole(actor),
        action: `payout.approve.${side}`,
        entityType: 'payout',
        entityId: payout.id,
        before: { status: payout.status },
        after: { [`${side}ApprovedBy`]: userId, status: bothApproved ? 'approved' : 'draft' },
      });
      return toView({
        ...payout,
        status: bothApproved ? 'approved' : 'draft',
        financeApprovedBy: side === 'finance' ? userId : payout.financeApprovedBy,
        opsApprovedBy: side === 'ops' ? userId : payout.opsApprovedBy,
      });
    });
  }

  /** Begin the simulated B2C once both approvals are in (`approved → processing`). */
  async function executePayout(actor: Actor, ulid: string): Promise<PayoutView> {
    return withTransaction(async ({ payouts }) => {
      const payout = await payouts.lockPayoutByUlid(ulid);
      if (!payout) {
        throw notFound('Payout not found');
      }
      if (payout.status !== 'approved') {
        throw conflict('PAYOUT_NOT_APPROVED', `Payout is ${payout.status}, not approved`);
      }
      const payeePhone = await payouts.getPayeeMsisdn(payout.payeeType, payout.payeeId);
      const { externalRef } = await gateway.initiateB2c({
        payeeType: payout.payeeType,
        payeeId: payout.payeeId,
        amountCents: payout.amountCents,
        reference: payout.ulid,
        payeePhone,
      });
      await payouts.setPayoutProcessing(payout.id, externalRef);
      await auditService.record({
        actorUserId: await payouts.findUserIdByUlid(actor.ulid),
        actorRole: actorRole(actor),
        action: 'payout.execute',
        entityType: 'payout',
        entityId: payout.id,
        before: { status: 'approved' },
        after: { status: 'processing', externalRef },
      });
      return toView({ ...payout, status: 'processing', externalRef });
    });
  }

  /**
   * Core idempotent confirm applied to an already-locked payout. On success post the ledger
   * draw-down (`DR payable / CR mpesa_clearing`, idempotency `payout:{id}`) and mark the payout (and
   * any source settlements) paid. Replaying a final payout is a no-op.
   */
  async function doConfirm(
    repos: PayoutRepos,
    payout: PayoutRecord,
    success: boolean,
  ): Promise<ConfirmOutcome> {
    if (payout.status === 'paid' || payout.status === 'failed') {
      return payout.status === 'paid' ? 'already_final' : 'failed';
    }
    if (payout.status !== 'processing') {
      throw conflict('PAYOUT_NOT_PROCESSING', `Payout is ${payout.status}, not processing`);
    }
    if (!success) {
      await repos.payouts.setPayoutFailed(payout.id);
      return 'failed';
    }
    await ledgerService.post(repos.ledger, {
      kind: 'payout',
      refType: 'payout',
      refId: payout.id,
      idempotencyKey: `payout:${payout.id}`,
      lines: buildPayoutLines(payout.payeeType, payout.payeeId, payout.amountCents),
    });
    await repos.payouts.setPayoutPaid(payout.id);
    await repos.payouts.markSettlementsPaid(await repos.payouts.settlementRefsForPayout(payout.id));
    return 'paid';
  }

  /** Apply the confirmed B2C result by payout ulid (dev-simulate seam). Idempotent. */
  async function confirmPayout(ulid: string, success: boolean): Promise<ConfirmOutcome> {
    return withTransaction(async (repos) => {
      const payout = await repos.payouts.lockPayoutByUlid(ulid);
      if (!payout) {
        throw notFound('Payout not found');
      }
      return doConfirm(repos, payout, success);
    });
  }

  /**
   * Apply a Daraja B2C result callback (doc 07 §10). The raw event is persisted + de-duplicated by
   * `conversationId:resultCode` (replay → `duplicate`), then the payout is matched by its
   * `external_ref` (the conversation id) and confirmed. An unknown id is recorded, not dropped.
   */
  async function applyB2cResult(input: {
    conversationId: string;
    resultCode: number;
    rawPayload: unknown;
  }): Promise<ConfirmOutcome | 'duplicate' | 'unknown'> {
    return withTransaction(async (repos) => {
      const payout = await repos.payouts.lockPayoutByExternalRef(input.conversationId);
      const fresh = await repos.payouts.insertPayoutEventDedup({
        payoutId: payout?.id ?? null,
        source: 'b2c_result',
        dedupeKey: `${input.conversationId}:${input.resultCode}`,
        resultCode: input.resultCode,
        rawPayload: input.rawPayload,
      });
      if (!fresh) {
        return 'duplicate';
      }
      if (!payout) {
        return 'unknown';
      }
      return doConfirm(repos, payout, input.resultCode === 0);
    });
  }

  function simulate(ulid: string, outcome: 'success' | 'fail'): Promise<ConfirmOutcome> {
    return confirmPayout(ulid, outcome === 'success');
  }

  async function getPayout(ulid: string): Promise<PayoutView> {
    const payout = await withTransaction(({ payouts }) => payouts.findPayoutByUlid(ulid));
    if (!payout) {
      throw notFound('Payout not found');
    }
    return toView(payout);
  }

  async function listPayouts(): Promise<PayoutView[]> {
    const rows = await withTransaction(({ payouts }) => payouts.listPayouts());
    return rows.map(toView);
  }

  return {
    generatePayouts,
    approveFinance: (actor: Actor, ulid: string) => approve(actor, ulid, 'finance'),
    approveOps: (actor: Actor, ulid: string) => approve(actor, ulid, 'ops'),
    executePayout,
    confirmPayout,
    applyB2cResult,
    simulate,
    getPayout,
    listPayouts,
  };
}

export type PayoutService = ReturnType<typeof createPayoutService>;
