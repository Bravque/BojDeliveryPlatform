import { describe, expect, it } from 'vitest';
import { createFulfillmentService, type Actor } from './fulfillment-service';
import type { InsertStatusHistoryInput, OrderRecord, OrdersRepo } from './repo';
import type { OrderStatus } from './state-machine';

function orderRecord(over: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 1,
    ulid: 'ORD1',
    orderNumber: 'BOJ-ORD001',
    customerId: 5,
    merchantId: 9,
    status: 'placed',
    paymentStatus: 'paid',
    subtotalCents: 30_200,
    deliveryFeeCents: 10_000,
    serviceFeeCents: 0,
    discountCents: 0,
    totalCents: 40_200,
    commissionBps: 1_000,
    commissionCents: 3_020,
    currency: 'KES',
    distanceM: null,
    cancelledReason: null,
    createdAt: new Date(),
    ...over,
  };
}

function setup(opts: { status?: OrderStatus; staff?: string[] } = {}) {
  const order = orderRecord({ status: opts.status ?? 'placed' });
  const history: InsertStatusHistoryInput[] = [];
  const repo = {
    lockOrderByUlid: (ulid: string) => Promise.resolve(ulid === order.ulid ? order : null),
    findMerchantStaffUlids: () => Promise.resolve(opts.staff ?? ['OWNER']),
    setOrderStatus: (_id: number, status: OrderStatus, reason: string | null) => {
      order.status = status;
      order.cancelledReason = reason;
      return Promise.resolve();
    },
    insertStatusHistory: (h: InsertStatusHistoryInput) => {
      history.push(h);
      return Promise.resolve();
    },
    findUserIdByUlid: () => Promise.resolve(42),
  } as unknown as OrdersRepo;
  const emitted: Array<{ orderUlid: string; toStatus: string }> = [];
  const svc = createFulfillmentService({
    withTransaction: (work) => work(repo),
    events: {
      orderStatusChanged: (orderUlid, toStatus) => emitted.push({ orderUlid, toStatus }),
      riderOffered: () => {},
    },
  });
  return { svc, order, history, emitted };
}

const OWNER: Actor = { ulid: 'OWNER', roles: ['merchant_owner'] };
const STRANGER: Actor = { ulid: 'STRANGER', roles: ['merchant_owner'] };
const ADMIN: Actor = { ulid: 'ADMIN', roles: ['admin'] };

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

describe('fulfillment service', () => {
  it('accepts a placed order and records merchant history', async () => {
    const { svc, order, history } = setup();
    const view = await svc.acceptOrder(OWNER, 'ORD1');
    expect(view.status).toBe('merchant_accepted');
    expect(order.status).toBe('merchant_accepted');
    expect(history.at(-1)).toMatchObject({ toStatus: 'merchant_accepted', actorType: 'merchant' });
  });

  it('walks preparing then ready', async () => {
    expect(
      (await setup({ status: 'merchant_accepted' }).svc.startPreparing(OWNER, 'ORD1')).status,
    ).toBe('preparing');
    expect(
      (await setup({ status: 'preparing' }).svc.markReadyForPickup(OWNER, 'ORD1')).status,
    ).toBe('ready_for_pickup');
  });

  it('rejects an illegal transition with 409 (ready before accept)', async () => {
    const { svc } = setup({ status: 'placed' });
    expect(await thrownStatus(svc.markReadyForPickup(OWNER, 'ORD1'))).toBe(409);
  });

  it('forbids a merchant who does not own the order (403)', async () => {
    const { svc } = setup({ staff: ['OWNER'] });
    expect(await thrownStatus(svc.acceptOrder(STRANGER, 'ORD1'))).toBe(403);
  });

  it('lets an admin act on any order (no ownership needed)', async () => {
    const { svc } = setup({ staff: [] });
    const view = await svc.acceptOrder(ADMIN, 'ORD1');
    expect(view.status).toBe('merchant_accepted');
  });

  it('rejects an order, recording the reason', async () => {
    const { svc, order, history } = setup();
    const view = await svc.rejectOrder(OWNER, 'ORD1', 'kitchen closed');
    expect(view.status).toBe('rejected');
    expect(order.cancelledReason).toBe('kitchen closed');
    expect(history.at(-1)).toMatchObject({ toStatus: 'rejected', reason: 'kitchen closed' });
  });

  it('404s an unknown order', async () => {
    const { svc } = setup();
    expect(await thrownStatus(svc.acceptOrder(OWNER, 'NOPE'))).toBe(404);
  });

  it('emits a realtime status change after a successful transition, not on failure', async () => {
    const ok = setup();
    await ok.svc.acceptOrder(OWNER, 'ORD1');
    expect(ok.emitted).toEqual([{ orderUlid: 'ORD1', toStatus: 'merchant_accepted' }]);

    const bad = setup({ status: 'placed' });
    await thrownStatus(bad.svc.markReadyForPickup(OWNER, 'ORD1')); // illegal → throws
    expect(bad.emitted).toEqual([]); // no emit when the transaction never committed
  });
});
