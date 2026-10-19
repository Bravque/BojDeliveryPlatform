import { newUlid } from '../auth/crypto';
import { notFound, unauthorized } from '../http/errors';
import { assertTransition } from '../orders/state-machine';
import type { PaymentGateway } from './gateway';
import type { PaymentMethod, PaymentRecord, PaymentsRepo } from './repo';

export interface Actor {
  ulid: string;
  roles: string[];
}

export interface InitiatePaymentInput {
  idempotencyKey: string;
  phone?: string | null;
}

export interface PaymentView {
  ulid: string;
  orderUlid: string;
  status: string;
  method: PaymentMethod;
  amountCents: number;
  currency: string;
  checkoutRequestId: string | null;
}

export interface PaymentServiceDeps {
  readRepo: PaymentsRepo;
  withTransaction: <T>(work: (repo: PaymentsRepo) => Promise<T>) => Promise<T>;
  gateway: PaymentGateway;
  /** Label stored on the payment row for the active provider (e.g. 'simulated'). */
  method: PaymentMethod;
}

function toView(payment: PaymentRecord, orderUlid: string): PaymentView {
  return {
    ulid: payment.ulid,
    orderUlid,
    status: payment.status,
    method: payment.method,
    amountCents: payment.amountCents,
    currency: payment.currency,
    checkoutRequestId: payment.checkoutRequestId,
  };
}

export function createPaymentService(deps: PaymentServiceDeps) {
  const { readRepo, withTransaction, gateway, method } = deps;

  function isAdmin(actor: Actor): boolean {
    return actor.roles.includes('admin') || actor.roles.includes('ops');
  }

  async function requireUserId(actor: Actor): Promise<number> {
    const userId = await readRepo.findUserIdByUlid(actor.ulid);
    if (userId === null) {
      throw unauthorized('Unknown principal');
    }
    return userId;
  }

  /** Return an already-recorded payment for this idempotency key, scoped to the caller. */
  async function reuseExisting(userId: number, existing: PaymentRecord): Promise<PaymentView> {
    const owner = await readRepo.findOrderUlidForPayment(existing.id);
    if (!owner || owner.customerId !== userId) {
      throw notFound('Payment not found');
    }
    return toView(existing, owner.orderUlid);
  }

  async function initiatePayment(
    actor: Actor,
    orderUlid: string,
    input: InitiatePaymentInput,
  ): Promise<PaymentView> {
    const userId = await requireUserId(actor);

    const existing = await readRepo.findPaymentByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return reuseExisting(userId, existing);
    }

    const order = await readRepo.findOrderForPayment(orderUlid);
    if (!order || order.customerId !== userId) {
      throw notFound('Order not found');
    }
    const fromStatus = order.status;
    assertTransition(fromStatus, 'payment_pending'); // draft / payment_failed → payment_pending

    const paymentUlid = newUlid();
    const payment = await withTransaction(async (repo) => {
      // Re-check inside the transaction to collapse a racing double-submit of the same key.
      const dup = await repo.findPaymentByIdempotencyKey(input.idempotencyKey);
      if (dup) {
        return dup;
      }
      const paymentId = await repo.insertPayment({
        ulid: paymentUlid,
        orderId: order.id,
        method,
        amountCents: order.totalCents,
        currency: order.currency,
        idempotencyKey: input.idempotencyKey,
      });
      // SimulatedGateway is synchronous/in-process, so the STK push can run inside the transaction.
      // The Daraja adapter (Phase 8) will move the network call out and reconcile via the status query.
      const init = await gateway.initiateStkPush({
        orderNumber: order.orderNumber,
        amountCents: order.totalCents,
        phone: input.phone ?? null,
        idempotencyKey: input.idempotencyKey,
      });
      await repo.markPending(paymentId, {
        checkoutRequestId: init.checkoutRequestId,
        merchantRequestId: init.merchantRequestId,
      });
      await repo.setOrderStatus(order.id, 'payment_pending');
      await repo.insertStatusHistory({
        orderId: order.id,
        fromStatus,
        toStatus: 'payment_pending',
        actorType: 'customer',
        actorUserId: userId,
      });
      const created = await repo.findPaymentByUlid(paymentUlid);
      if (!created) {
        throw new Error('Payment vanished after creation');
      }
      return created;
    });

    return toView(payment, orderUlid);
  }

  async function getPayment(actor: Actor, paymentUlid: string): Promise<PaymentView> {
    const userId = await requireUserId(actor);
    const payment = await readRepo.findPaymentByUlid(paymentUlid);
    if (!payment) {
      throw notFound('Payment not found');
    }
    const owner = await readRepo.findOrderUlidForPayment(payment.id);
    if (!owner || (!isAdmin(actor) && owner.customerId !== userId)) {
      throw notFound('Payment not found');
    }
    return toView(payment, owner.orderUlid);
  }

  return { initiatePayment, getPayment };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
