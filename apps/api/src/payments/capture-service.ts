import { conflict, notFound } from '../http/errors';
import { newUlid } from '../auth/crypto';
import type { LedgerRepo } from '../ledger/repo';
import type { LedgerService } from '../ledger/ledger-service';
import { assertTransition } from '../orders/state-machine';
import { noopPublisher, type DomainEventPublisher } from '../platform/events/publisher';
import { buildCaptureLines, type CaptureOutcome, type StkCallback } from './capture';
import { buildAutoRefundLines } from './refund';
import type { PaymentsRepo } from './repo';

/** The transaction-bound repos a capture needs: payment/order writes + the ledger. */
export interface CaptureRepos {
  payments: PaymentsRepo;
  ledger: LedgerRepo;
}

export interface CaptureServiceDeps {
  readRepo: PaymentsRepo;
  withTransaction: <T>(work: (repos: CaptureRepos) => Promise<T>) => Promise<T>;
  ledgerService: LedgerService;
  /** Realtime publisher; emitted after commit (best-effort). Defaults to no-op. */
  events?: DomainEventPublisher;
}

export function createCaptureService(deps: CaptureServiceDeps) {
  const { readRepo, withTransaction, ledgerService, events = noopPublisher } = deps;

  /**
   * Process an STK result idempotently (doc 07 §3–4). Recording the raw event with a UNIQUE
   * `dedupe_key` collapses duplicate callbacks to a no-op; a verified success whose amount matches
   * captures to the ledger and moves the order to `placed`; a failure releases the stock
   * reservation; an amount mismatch is quarantined (event kept, no capture).
   */
  async function processStkResult(
    callback: StkCallback,
    source: 'stk_callback' | 'status_query' | 'reconciliation' = 'stk_callback',
  ): Promise<CaptureOutcome> {
    let emit: { ulid: string; status: string } | null = null;
    const outcome = await withTransaction(async ({ payments, ledger }) => {
      const payment = await payments.findPaymentByCheckoutRequestId(callback.checkoutRequestId);
      const fresh = await payments.insertPaymentEventDedup({
        paymentId: payment?.id ?? null,
        source,
        dedupeKey: `${callback.checkoutRequestId}:${callback.resultCode}`,
        resultCode: callback.resultCode,
        rawPayload: callback,
      });
      if (!fresh) {
        return 'duplicate';
      }
      if (!payment) {
        return 'unknown_payment';
      }
      if (payment.status !== 'pending' && payment.status !== 'initiated') {
        // Late success for a payment we already failed locally (timeout / cancel): the funds were
        // actually collected, so raise an idempotent auto-refund (doc 07 §5, §8). Earnings were
        // never posted (order cancelled), so the inflow goes straight into `refunds_payable`.
        if (
          callback.resultCode === 0 &&
          (callback.amountCents ?? null) === payment.amountCents &&
          (payment.status === 'failed' || payment.status === 'timed_out')
        ) {
          const autoKey = `auto_refund:${payment.id}`;
          if (await payments.findRefundByIdempotencyKey(autoKey)) {
            return 'auto_refunded';
          }
          const refundId = await payments.insertRefund({
            ulid: newUlid(),
            orderId: payment.orderId,
            paymentId: payment.id,
            amountCents: payment.amountCents,
            reason: 'Late success after local failure/cancel — auto-refund',
            source: 'auto',
            requestedBy: null,
            status: 'completed',
            idempotencyKey: autoKey,
          });
          await ledgerService.post(ledger, {
            kind: 'order_refund',
            refType: 'refund',
            refId: refundId,
            idempotencyKey: `order_refund:${refundId}`,
            lines: buildAutoRefundLines(payment.amountCents),
          });
          await payments.markPaymentReversed(payment.id, callback.mpesaReceipt ?? null);
          await payments.setOrderPaymentStatus(payment.orderId, 'refunded');
          return 'auto_refunded';
        }
        return 'already_final';
      }

      const snapshot = await payments.getOrderMoneySnapshot(payment.orderId);
      if (!snapshot) {
        throw new Error('Order missing for payment');
      }
      const fromStatus = snapshot.status;

      if (callback.resultCode === 0) {
        if ((callback.amountCents ?? null) !== payment.amountCents) {
          return 'amount_mismatch'; // quarantined — never auto-captured on mismatch
        }
        assertTransition(fromStatus, 'placed');
        await payments.markPaymentSucceeded(payment.id, callback.mpesaReceipt ?? null);
        await ledgerService.post(ledger, {
          kind: 'order_capture',
          refType: 'payment',
          refId: payment.id,
          idempotencyKey: `order_capture:${payment.id}`,
          lines: buildCaptureLines(snapshot),
        });
        await payments.setOrderStatusAndPayment(snapshot.id, 'placed', 'paid');
        await payments.insertStatusHistory({
          orderId: snapshot.id,
          fromStatus,
          toStatus: 'placed',
          actorType: 'system',
          actorUserId: null,
        });
        emit = { ulid: snapshot.ulid, status: 'placed' };
        return 'captured';
      }

      // Failure → release the stock reservation and fail the order.
      assertTransition(fromStatus, 'payment_failed');
      await payments.markPaymentFailed(payment.id, 'failed');
      for (const line of await payments.listOrderStockLines(snapshot.id)) {
        await payments.releaseStock(line.productId, line.quantity);
      }
      await payments.setOrderStatusAndPayment(snapshot.id, 'payment_failed', 'failed');
      await payments.insertStatusHistory({
        orderId: snapshot.id,
        fromStatus,
        toStatus: 'payment_failed',
        actorType: 'system',
        actorUserId: null,
      });
      emit = { ulid: snapshot.ulid, status: 'payment_failed' };
      return 'failed';
    });
    // `emit` is set inside the transaction callback; the cast restores the union for CFA.
    const pending = emit as { ulid: string; status: string } | null;
    if (pending) {
      events.orderStatusChanged(pending.ulid, pending.status); // after commit — best-effort
    }
    return outcome;
  }

  /**
   * Non-production helper: synthesise an STK callback for a payment and process it, so the full
   * capture/fail path is exercised without real Daraja. `amountOverrideCents` lets a caller force
   * an amount mismatch.
   */
  async function simulate(
    paymentUlid: string,
    outcome: 'success' | 'fail',
    amountOverrideCents?: number,
  ): Promise<CaptureOutcome> {
    const payment = await readRepo.findPaymentByUlid(paymentUlid);
    if (!payment) {
      throw notFound('Payment not found');
    }
    if (!payment.checkoutRequestId) {
      throw conflict('PAYMENT_NOT_INITIATED', 'Payment has no STK push to simulate');
    }
    const callback: StkCallback =
      outcome === 'success'
        ? {
            checkoutRequestId: payment.checkoutRequestId,
            resultCode: 0,
            resultDesc: 'The service request is processed successfully.',
            amountCents: amountOverrideCents ?? payment.amountCents,
            mpesaReceipt: `SIMRCPT${newUlid().slice(-8).toUpperCase()}`,
          }
        : {
            checkoutRequestId: payment.checkoutRequestId,
            resultCode: 1032,
            resultDesc: 'Request cancelled by user.',
            amountCents: null,
            mpesaReceipt: null,
          };
    return processStkResult(callback);
  }

  return { processStkResult, simulate };
}

export type CaptureService = ReturnType<typeof createCaptureService>;
