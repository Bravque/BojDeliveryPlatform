import { newUlid } from '../auth/crypto';
import { assertDifferentActor } from '../auth/policy';
import { badRequest, conflict, notFound, unauthorized } from '../http/errors';
import type { LedgerRepo } from '../ledger/repo';
import type { LedgerService } from '../ledger/ledger-service';
import { assertTransition } from '../orders/state-machine';
import type { PaymentGateway } from './gateway';
import { buildRefundLines, type RefundRecord } from './refund';
import type { PaymentsRepo } from './repo';

export interface Actor {
  ulid: string;
  roles: string[];
}

export interface RequestRefundInput {
  amountCents: number;
  reason: string;
  idempotencyKey: string;
}

export interface RefundView {
  ulid: string;
  orderUlid: string | null;
  status: string;
  source: string;
  amountCents: number;
  reason: string;
  providerRef: string | null;
}

export type RefundExecOutcome = 'completed' | 'failed' | 'already_final';

/** The transaction-bound repos a refund mutation needs: refund/payment/order writes + the ledger. */
export interface RefundRepos {
  payments: PaymentsRepo;
  ledger: LedgerRepo;
}

export interface RefundServiceDeps {
  readRepo: PaymentsRepo;
  withTransaction: <T>(work: (repos: RefundRepos) => Promise<T>) => Promise<T>;
  ledgerService: LedgerService;
  gateway: PaymentGateway;
}

export function createRefundService(deps: RefundServiceDeps) {
  const { readRepo, withTransaction, ledgerService, gateway } = deps;

  async function requireUserId(actor: Actor): Promise<number> {
    const userId = await readRepo.findUserIdByUlid(actor.ulid);
    if (userId === null) {
      throw unauthorized('Unknown principal');
    }
    return userId;
  }

  async function toView(refund: RefundRecord): Promise<RefundView> {
    const owner = await readRepo.findOrderUlidForPayment(refund.paymentId);
    return {
      ulid: refund.ulid,
      orderUlid: owner?.orderUlid ?? null,
      status: refund.status,
      source: refund.source,
      amountCents: refund.amountCents,
      reason: refund.reason,
      providerRef: refund.providerRef,
    };
  }

  /**
   * Record a refund request against a captured order (doc 07 §8). The amount is validated
   * server-side to be `≤ net refundable` (total minus already-completed refunds); the client
   * never dictates what is owed. Idempotent on the caller's `Idempotency-Key`.
   */
  async function requestRefund(
    actor: Actor,
    orderUlid: string,
    input: RequestRefundInput,
  ): Promise<RefundView> {
    const requesterId = await requireUserId(actor);

    const existing = await readRepo.findRefundByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return toView(existing);
    }

    const order = await readRepo.findOrderForRefund(orderUlid);
    if (!order) {
      throw notFound('Order not found');
    }
    if (order.paymentStatus !== 'paid' && order.paymentStatus !== 'partially_refunded') {
      throw conflict('ORDER_NOT_REFUNDABLE', 'Order has no captured payment to refund');
    }
    const payment = await readRepo.findSucceededPaymentByOrderId(order.id);
    if (!payment) {
      throw conflict('ORDER_NOT_REFUNDABLE', 'Order has no captured payment to refund');
    }

    const alreadyRefunded = await readRepo.sumCompletedRefunds(order.id);
    const netRefundable = order.totalCents - alreadyRefunded;
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw badRequest('Refund amount must be a positive integer (cents)', [
        { field: 'amountCents', issue: 'positive integer' },
      ]);
    }
    if (input.amountCents > netRefundable) {
      throw badRequest('Refund amount exceeds the net refundable total', [
        { field: 'amountCents', issue: `max ${netRefundable}` },
      ]);
    }

    const refundUlid = newUlid();
    await withTransaction(async ({ payments }) => {
      // Re-check inside the transaction to collapse a racing double-submit of the same key.
      const dup = await payments.findRefundByIdempotencyKey(input.idempotencyKey);
      if (dup) {
        return;
      }
      await payments.insertRefund({
        ulid: refundUlid,
        orderId: order.id,
        paymentId: payment.id,
        amountCents: input.amountCents,
        reason: input.reason,
        source: 'manual',
        requestedBy: requesterId,
        status: 'requested',
        idempotencyKey: input.idempotencyKey,
      });
    });

    const created =
      (await readRepo.findRefundByUlid(refundUlid)) ??
      (await readRepo.findRefundByIdempotencyKey(input.idempotencyKey));
    if (!created) {
      throw new Error('Refund vanished after creation');
    }
    return toView(created);
  }

  /**
   * Approve a requested refund and begin the provider reversal (→ `processing`). Enforces
   * separation of duties: the approver may not be the requester (doc 06 §3.3). Completion is
   * confirmed out-of-band (dev-simulate / reconcile), never here (D6).
   */
  async function approveRefund(actor: Actor, refundUlid: string): Promise<RefundView> {
    const approverId = await requireUserId(actor);

    const refund = await withTransaction(async ({ payments }) => {
      const locked = await payments.lockRefundByUlid(refundUlid);
      if (!locked) {
        throw notFound('Refund not found');
      }
      if (locked.source !== 'manual') {
        throw conflict('REFUND_NOT_APPROVABLE', 'Automatic refunds are not manually approved');
      }
      if (locked.status !== 'requested') {
        throw conflict('REFUND_NOT_PENDING', `Refund is ${locked.status}, not requested`);
      }
      if (locked.requestedBy !== null) {
        const requesterUlid = await payments.findUserUlidById(locked.requestedBy);
        assertDifferentActor(requesterUlid ?? '', actor.ulid);
      }

      const payment = await payments.findSucceededPaymentByOrderId(locked.orderId);
      const reversal = await gateway.initiateReversal({
        originalReceipt: payment?.mpesaReceipt ?? null,
        checkoutRequestId: payment?.checkoutRequestId ?? null,
        amountCents: locked.amountCents,
        reference: locked.ulid,
      });
      await payments.markRefundProcessing(locked.id, approverId, reversal.reversalId);
      const updated = await payments.findRefundByUlid(refundUlid);
      if (!updated) {
        throw new Error('Refund vanished after approval');
      }
      return updated;
    });

    return toView(refund);
  }

  /** Reject a requested refund (no money moves). */
  async function rejectRefund(actor: Actor, refundUlid: string): Promise<RefundView> {
    const approverId = await requireUserId(actor);
    const refund = await withTransaction(async ({ payments }) => {
      const locked = await payments.lockRefundByUlid(refundUlid);
      if (!locked) {
        throw notFound('Refund not found');
      }
      if (locked.status !== 'requested') {
        throw conflict('REFUND_NOT_PENDING', `Refund is ${locked.status}, not requested`);
      }
      await payments.markRefundRejected(locked.id, approverId);
      const updated = await payments.findRefundByUlid(refundUlid);
      if (!updated) {
        throw new Error('Refund vanished after rejection');
      }
      return updated;
    });
    return toView(refund);
  }

  /**
   * Apply a confirmed provider reversal result to a `processing` refund (idempotent). On success,
   * post the ledger reversal into `refunds_payable` (full = reverse the capture; partial = merchant
   * bears it) and reflect `refunded` / `partially_refunded` on the order. Replaying is a no-op.
   */
  async function processReversalResult(
    refundUlid: string,
    success: boolean,
  ): Promise<RefundExecOutcome> {
    return withTransaction(async ({ payments, ledger }) => {
      const refund = await payments.lockRefundByUlid(refundUlid);
      if (!refund) {
        throw notFound('Refund not found');
      }
      if (refund.status === 'completed' || refund.status === 'failed') {
        return refund.status === 'completed' ? 'already_final' : 'failed';
      }
      if (refund.status !== 'processing') {
        throw conflict('REFUND_NOT_PROCESSING', `Refund is ${refund.status}, not processing`);
      }

      if (!success) {
        await payments.markRefundFailed(refund.id);
        return 'failed';
      }

      const snapshot = await payments.getOrderMoneySnapshot(refund.orderId);
      if (!snapshot) {
        throw new Error('Order missing for refund');
      }
      const priorRefunded = await payments.sumCompletedRefunds(refund.orderId);
      const isFull = priorRefunded === 0 && refund.amountCents === snapshot.totalCents;

      await ledgerService.post(ledger, {
        kind: 'order_refund',
        refType: 'refund',
        refId: refund.id,
        idempotencyKey: `order_refund:${refund.id}`,
        lines: buildRefundLines(snapshot, refund.amountCents, isFull),
      });
      await payments.markRefundCompleted(refund.id);

      const totalRefunded = priorRefunded + refund.amountCents;
      const fullyRefunded = totalRefunded >= snapshot.totalCents;
      if (fullyRefunded && (snapshot.status === 'cancelled' || snapshot.status === 'rejected')) {
        // A cancelled/rejected order can move to the terminal `refunded` state.
        assertTransition(snapshot.status, 'refunded');
        await payments.setOrderStatusAndPayment(refund.orderId, 'refunded', 'refunded');
        await payments.insertStatusHistory({
          orderId: refund.orderId,
          fromStatus: snapshot.status,
          toStatus: 'refunded',
          actorType: 'system',
          actorUserId: null,
        });
      } else {
        await payments.setOrderPaymentStatus(
          refund.orderId,
          fullyRefunded ? 'refunded' : 'partially_refunded',
        );
      }
      return 'completed';
    });
  }

  /** Non-production helper: confirm the simulated reversal outcome for a refund (admin only). */
  function simulate(refundUlid: string, outcome: 'success' | 'fail'): Promise<RefundExecOutcome> {
    return processReversalResult(refundUlid, outcome === 'success');
  }

  async function getRefund(refundUlid: string): Promise<RefundView> {
    const refund = await readRepo.findRefundByUlid(refundUlid);
    if (!refund) {
      throw notFound('Refund not found');
    }
    return toView(refund);
  }

  return { requestRefund, approveRefund, rejectRefund, processReversalResult, simulate, getRefund };
}

export type RefundService = ReturnType<typeof createRefundService>;
