import { describe, expect, it } from 'vitest';
import type { OrderStatus } from '../orders/state-machine';
import type { PaymentGateway } from './gateway';
import { createPaymentService, type Actor } from './payment-service';
import type { InsertPaymentInput, OrderForPayment, PaymentRecord, PaymentsRepo } from './repo';

class FakePaymentsRepo implements PaymentsRepo {
  users = new Map<string, number>([
    ['cust', 7],
    ['other', 8],
    ['admin', 9],
  ]);
  order: OrderForPayment = {
    id: 1,
    ulid: 'ORD1',
    orderNumber: 'BOJ-ABCDEF12',
    customerId: 7,
    status: 'draft',
    totalCents: 40_200,
    currency: 'KES',
  };
  payments: PaymentRecord[] = [];
  history: Array<{ fromStatus: OrderStatus; toStatus: OrderStatus }> = [];
  private seq = 0;

  findUserIdByUlid(ulid: string): Promise<number | null> {
    return Promise.resolve(this.users.get(ulid) ?? null);
  }
  findOrderForPayment(orderUlid: string): Promise<OrderForPayment | null> {
    return Promise.resolve(orderUlid === this.order.ulid ? this.order : null);
  }
  findPaymentByIdempotencyKey(key: string): Promise<PaymentRecord | null> {
    return Promise.resolve(this.payments.find((p) => p.idempotencyKey === key) ?? null);
  }
  findPaymentByUlid(ulid: string): Promise<PaymentRecord | null> {
    return Promise.resolve(this.payments.find((p) => p.ulid === ulid) ?? null);
  }
  findOrderUlidForPayment(
    paymentId: number,
  ): Promise<{ orderUlid: string; customerId: number } | null> {
    const p = this.payments.find((x) => x.id === paymentId);
    if (!p || p.orderId !== this.order.id) return Promise.resolve(null);
    return Promise.resolve({ orderUlid: this.order.ulid, customerId: this.order.customerId });
  }
  insertPayment(input: InsertPaymentInput): Promise<number> {
    const id = ++this.seq;
    this.payments.push({
      id,
      ulid: input.ulid,
      orderId: input.orderId,
      method: input.method,
      amountCents: input.amountCents,
      currency: input.currency,
      status: 'initiated',
      checkoutRequestId: null,
      merchantRequestId: null,
      mpesaReceipt: null,
      idempotencyKey: input.idempotencyKey,
    });
    return Promise.resolve(id);
  }
  markPending(
    paymentId: number,
    ids: { checkoutRequestId: string; merchantRequestId: string },
  ): Promise<void> {
    const p = this.payments.find((x) => x.id === paymentId);
    if (p) {
      p.status = 'pending';
      p.checkoutRequestId = ids.checkoutRequestId;
      p.merchantRequestId = ids.merchantRequestId;
    }
    return Promise.resolve();
  }
  setOrderStatus(_orderId: number, status: OrderStatus): Promise<void> {
    this.order.status = status;
    return Promise.resolve();
  }
  insertStatusHistory(input: { fromStatus: OrderStatus; toStatus: OrderStatus }): Promise<void> {
    this.history.push({ fromStatus: input.fromStatus, toStatus: input.toStatus });
    return Promise.resolve();
  }
}

let pushes = 0;
const gateway: PaymentGateway = {
  initiateStkPush: () => {
    pushes += 1;
    return Promise.resolve({ checkoutRequestId: 'SIM-1', merchantRequestId: 'SIMMR-1' });
  },
  queryStkStatus: () =>
    Promise.resolve({ status: 'pending', resultCode: 0, resultDesc: '', mpesaReceipt: null }),
};

const CUST: Actor = { ulid: 'cust', roles: ['customer'] };
const OTHER: Actor = { ulid: 'other', roles: ['customer'] };
const ADMIN: Actor = { ulid: 'admin', roles: ['admin'] };

function svcWith(repo = new FakePaymentsRepo()) {
  return {
    repo,
    svc: createPaymentService({
      readRepo: repo,
      withTransaction: (work) => work(repo),
      gateway,
      method: 'simulated',
    }),
  };
}

function thrown(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number; code?: string }) => `${e.status}:${e.code}`,
  );
}

describe('payment service — initiate', () => {
  it('initiates an STK push: payment pending + order → payment_pending + history', async () => {
    pushes = 0;
    const { repo, svc } = svcWith();
    const view = await svc.initiatePayment(CUST, 'ORD1', { idempotencyKey: 'k1' });
    expect(view.status).toBe('pending');
    expect(view.amountCents).toBe(40_200);
    expect(view.checkoutRequestId).toBe('SIM-1');
    expect(repo.order.status).toBe('payment_pending');
    expect(repo.history.at(-1)).toMatchObject({ fromStatus: 'draft', toStatus: 'payment_pending' });
    expect(pushes).toBe(1);
  });

  it('is idempotent for a repeated idempotency key (no second payment or push)', async () => {
    pushes = 0;
    const { repo, svc } = svcWith();
    const first = await svc.initiatePayment(CUST, 'ORD1', { idempotencyKey: 'k1' });
    const second = await svc.initiatePayment(CUST, 'ORD1', { idempotencyKey: 'k1' });
    expect(second.ulid).toBe(first.ulid);
    expect(repo.payments).toHaveLength(1);
    expect(pushes).toBe(1);
  });

  it('404s another customer’s order and 401s an unknown principal', async () => {
    expect(
      await thrown(svcWith().svc.initiatePayment(OTHER, 'ORD1', { idempotencyKey: 'k' })),
    ).toBe('404:NOT_FOUND');
    const ghost: Actor = { ulid: 'ghost', roles: ['customer'] };
    expect(
      await thrown(svcWith().svc.initiatePayment(ghost, 'ORD1', { idempotencyKey: 'k' })),
    ).toBe('401:UNAUTHORIZED');
  });

  it('rejects paying an order not in a payable state (409 ILLEGAL_TRANSITION)', async () => {
    const repo = new FakePaymentsRepo();
    repo.order.status = 'placed';
    expect(
      await thrown(svcWith(repo).svc.initiatePayment(CUST, 'ORD1', { idempotencyKey: 'k' })),
    ).toBe('409:ILLEGAL_TRANSITION');
  });
});

describe('payment service — getPayment', () => {
  it('returns the payment to its owner and to an admin, 404s a stranger', async () => {
    const { svc } = svcWith();
    const created = await svc.initiatePayment(CUST, 'ORD1', { idempotencyKey: 'k1' });
    expect((await svc.getPayment(CUST, created.ulid)).ulid).toBe(created.ulid);
    expect((await svc.getPayment(ADMIN, created.ulid)).ulid).toBe(created.ulid);
    expect(await thrown(svc.getPayment(OTHER, created.ulid))).toBe('404:NOT_FOUND');
  });
});
