import { describe, expect, it } from 'vitest';
import type { FeeResolver, ZoneResolver } from '../pricing/quote-service';
import type { PromotionRecord } from '../promotions/promotion';
import { createOrderService, type Actor } from './order-service';
import type {
  InsertOrderInput,
  InsertOrderItemInput,
  InsertStatusHistoryInput,
  OrderMerchant,
  OrderOption,
  OrderProduct,
  OrderRecord,
  OrdersRepo,
} from './repo';
import type { OrderStatus } from './state-machine';

interface Inv {
  track: boolean;
  quantity: number;
  reserved: number;
}

class FakeOrdersRepo implements OrdersRepo {
  users = new Map<string, number>([
    ['cust', 7],
    ['other', 8],
  ]);
  cart: { id: number; userId: number; merchantId: number | null } | null = {
    id: 1,
    userId: 7,
    merchantId: 1,
  };
  cartItems = [{ productId: 100, quantity: 2, optionUlids: ['O1'] }];
  address = { id: 50, lat: -1.0634, lng: 34.4731 };
  merchant: OrderMerchant = {
    id: 1,
    ulid: 'M1',
    name: 'Joe Kitchen',
    townId: 3,
    status: 'approved',
    commissionBps: 1_000,
    lat: -1.06,
    lng: 34.47,
  };
  products = new Map<number, OrderProduct>([
    [100, { id: 100, ulid: 'P1', name: 'Ugali', priceCents: 15_000, isAvailable: true }],
  ]);
  options = new Map<string, OrderOption>([
    ['O1', { ulid: 'O1', name: 'Large', priceDeltaCents: 100, isAvailable: true }],
  ]);
  inventory = new Map<number, Inv>([[100, { track: true, quantity: 5, reserved: 0 }]]);
  promotionsByCode = new Map<string, PromotionRecord>();
  redemptions: Array<{ promotionId: number; userId: number; orderId: number }> = [];
  orders: OrderRecord[] = [];
  orderItems: Array<InsertOrderItemInput & { id: number }> = [];
  orderItemOptions: Array<{ orderItemId: number; nameSnapshot: string; priceDeltaCents: number }> =
    [];
  history: InsertStatusHistoryInput[] = [];
  cartCleared = false;
  private orderSeq = 0;
  private itemSeq = 0;

  findUserIdByUlid(ulid: string): Promise<number | null> {
    return Promise.resolve(this.users.get(ulid) ?? null);
  }
  findCart(): Promise<{ id: number; merchantId: number | null } | null> {
    return Promise.resolve(
      this.cart ? { id: this.cart.id, merchantId: this.cart.merchantId } : null,
    );
  }
  listCartItems(): Promise<Array<{ productId: number; quantity: number; optionUlids: string[] }>> {
    return Promise.resolve(this.cartItems);
  }
  findAddressForUser(): Promise<{ id: number; lat: number; lng: number } | null> {
    return Promise.resolve(this.address);
  }
  getMerchant(): Promise<OrderMerchant | null> {
    return Promise.resolve(this.merchant);
  }
  getProducts(ids: number[]): Promise<OrderProduct[]> {
    return Promise.resolve([...this.products.values()].filter((p) => ids.includes(p.id)));
  }
  getOptions(ulids: string[]): Promise<OrderOption[]> {
    return Promise.resolve([...this.options.values()].filter((o) => ulids.includes(o.ulid)));
  }
  findPromotionByCode(code: string): Promise<PromotionRecord | null> {
    return Promise.resolve(this.promotionsByCode.get(code) ?? null);
  }
  countUserRedemptions(promotionId: number, userId: number): Promise<number> {
    return Promise.resolve(
      this.redemptions.filter((r) => r.promotionId === promotionId && r.userId === userId).length,
    );
  }
  reserve(productId: number, quantity: number): Promise<boolean> {
    const inv = this.inventory.get(productId);
    if (!inv || !inv.track) {
      return Promise.resolve(true);
    }
    if (inv.quantity - inv.reserved >= quantity) {
      inv.reserved += quantity;
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }
  release(productId: number, quantity: number): Promise<void> {
    const inv = this.inventory.get(productId);
    if (inv?.track) {
      inv.reserved = Math.max(0, inv.reserved - quantity);
    }
    return Promise.resolve();
  }
  incrementPromotionRedeemed(promotionId: number): Promise<boolean> {
    const promo = [...this.promotionsByCode.values()].find((p) => p.id === promotionId);
    if (!promo) return Promise.resolve(false);
    if (promo.totalLimit !== null && promo.totalRedeemed >= promo.totalLimit) {
      return Promise.resolve(false);
    }
    promo.totalRedeemed += 1;
    return Promise.resolve(true);
  }
  decrementPromotionRedeemed(promotionId: number): Promise<void> {
    const promo = [...this.promotionsByCode.values()].find((p) => p.id === promotionId);
    if (promo) promo.totalRedeemed = Math.max(0, promo.totalRedeemed - 1);
    return Promise.resolve();
  }
  insertPromotionRedemption(input: {
    promotionId: number;
    userId: number;
    orderId: number;
    discountCents: number;
  }): Promise<void> {
    this.redemptions.push(input);
    return Promise.resolve();
  }
  getRedemptionByOrder(orderId: number): Promise<{ promotionId: number } | null> {
    const r = this.redemptions.find((x) => x.orderId === orderId);
    return Promise.resolve(r ? { promotionId: r.promotionId } : null);
  }
  deletePromotionRedemptionByOrder(orderId: number): Promise<void> {
    this.redemptions = this.redemptions.filter((r) => r.orderId !== orderId);
    return Promise.resolve();
  }
  insertOrder(input: InsertOrderInput): Promise<number> {
    const id = ++this.orderSeq;
    this.orders.push({
      id,
      ulid: input.ulid,
      orderNumber: input.orderNumber,
      customerId: input.customerId,
      merchantId: input.merchantId,
      status: input.status,
      paymentStatus: 'unpaid',
      subtotalCents: input.subtotalCents,
      deliveryFeeCents: input.deliveryFeeCents,
      serviceFeeCents: input.serviceFeeCents,
      discountCents: input.discountCents,
      totalCents: input.totalCents,
      commissionBps: input.commissionBps,
      commissionCents: input.commissionCents,
      currency: 'KES',
      distanceM: input.distanceM,
      cancelledReason: null,
      createdAt: new Date(),
    });
    return Promise.resolve(id);
  }
  insertOrderItem(input: InsertOrderItemInput): Promise<number> {
    const id = ++this.itemSeq;
    this.orderItems.push({ ...input, id });
    return Promise.resolve(id);
  }
  insertOrderItemOption(input: {
    orderItemId: number;
    nameSnapshot: string;
    priceDeltaCents: number;
  }): Promise<void> {
    this.orderItemOptions.push(input);
    return Promise.resolve();
  }
  insertStatusHistory(input: InsertStatusHistoryInput): Promise<void> {
    this.history.push(input);
    return Promise.resolve();
  }
  setOrderStatus(
    orderId: number,
    status: OrderStatus,
    cancelledReason: string | null,
  ): Promise<void> {
    const o = this.orders.find((x) => x.id === orderId);
    if (o) {
      o.status = status;
      o.cancelledReason = cancelledReason;
    }
    return Promise.resolve();
  }
  clearCart(): Promise<void> {
    this.cartCleared = true;
    this.cartItems = [];
    if (this.cart) this.cart.merchantId = null;
    return Promise.resolve();
  }
  findOrderByUlid(ulid: string): Promise<OrderRecord | null> {
    return Promise.resolve(this.orders.find((o) => o.ulid === ulid) ?? null);
  }
  lockOrderByUlid(ulid: string): Promise<OrderRecord | null> {
    return Promise.resolve(this.orders.find((o) => o.ulid === ulid) ?? null);
  }
  findMerchantStaffUlids(): Promise<string[]> {
    return Promise.resolve([]);
  }
  listOrdersForUser(userId: number): Promise<OrderRecord[]> {
    return Promise.resolve(this.orders.filter((o) => o.customerId === userId));
  }
  listOrderStockLines(orderId: number): Promise<Array<{ productId: number; quantity: number }>> {
    return Promise.resolve(
      this.orderItems
        .filter((i) => i.orderId === orderId)
        .map((i) => ({ productId: i.productId, quantity: i.quantity })),
    );
  }
  getOrderItems(orderId: number): Promise<
    Array<{
      id: number;
      productUlid: string;
      nameSnapshot: string;
      unitPriceCents: number;
      quantity: number;
      lineTotalCents: number;
    }>
  > {
    return Promise.resolve(
      this.orderItems
        .filter((i) => i.orderId === orderId)
        .map((i) => ({
          id: i.id,
          productUlid: this.products.get(i.productId)?.ulid ?? '',
          nameSnapshot: i.nameSnapshot,
          unitPriceCents: i.unitPriceCents,
          quantity: i.quantity,
          lineTotalCents: i.lineTotalCents,
        })),
    );
  }
  getOrderItemOptions(
    orderItemIds: number[],
  ): Promise<Array<{ orderItemId: number; nameSnapshot: string; priceDeltaCents: number }>> {
    return Promise.resolve(
      this.orderItemOptions.filter((o) => orderItemIds.includes(o.orderItemId)),
    );
  }
}

const zones: ZoneResolver = {
  resolveZone: () => Promise.resolve({ id: 9, ulid: 'Z1', name: 'CBD' }),
};
const fees: FeeResolver = {
  resolveFee: (_z, distanceM) => Promise.resolve({ feeCents: 15_000, ruleUlid: 'F1', distanceM }),
};

const CUST: Actor = { ulid: 'cust', roles: ['customer'] };
const OTHER: Actor = { ulid: 'other', roles: ['customer'] };

function svcWith(
  repo = new FakeOrdersRepo(),
  overrides: Partial<{ zones: ZoneResolver; fees: FeeResolver }> = {},
) {
  const svc = createOrderService({
    readRepo: repo,
    withTransaction: (work) => work(repo),
    zones: overrides.zones ?? zones,
    fees: overrides.fees ?? fees,
  });
  return { repo, svc };
}

function thrown(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number; code?: string }) => `${e.status}:${e.code}`,
  );
}

function promo(over: Partial<PromotionRecord> = {}): PromotionRecord {
  return {
    id: 1,
    ulid: 'PR1',
    code: 'SAVE10',
    type: 'percentage',
    valueBps: 1_000,
    valueCents: null,
    maxDiscountCents: null,
    minSubtotalCents: 0,
    perUserLimit: 1,
    totalLimit: null,
    totalRedeemed: 0,
    startsAt: new Date('2020-01-01T00:00:00Z'),
    endsAt: new Date('2999-01-01T00:00:00Z'),
    isActive: true,
    ...over,
  };
}

describe('order service — createOrder', () => {
  it('snapshots the priced order as draft, reserves stock, and consumes the cart', async () => {
    const { repo, svc } = svcWith();
    const order = await svc.createOrder(CUST, { addressUlid: 'A1' });

    expect(order.status).toBe('draft');
    expect(order.subtotalCents).toBe(30_200); // 2 × (15000 + 100)
    expect(order.deliveryFeeCents).toBe(15_000);
    expect(order.totalCents).toBe(45_200);
    expect(order.commissionBps).toBe(1_000);
    expect(order.commissionCents).toBe(3_020); // 10% of 30200
    expect(order.items[0]?.options[0]?.name).toBe('Large');
    expect(order.orderNumber).toMatch(/^BOJ-/);

    expect(repo.inventory.get(100)?.reserved).toBe(2); // stock reserved
    expect(repo.cartCleared).toBe(true);
    expect(repo.history.at(-1)).toMatchObject({ fromStatus: null, toStatus: 'draft' });
  });

  it('rejects insufficient stock with 409 OUT_OF_STOCK', async () => {
    const repo = new FakeOrdersRepo();
    repo.inventory.set(100, { track: true, quantity: 1, reserved: 0 }); // only 1, need 2
    const { svc } = svcWith(repo);
    expect(await thrown(svc.createOrder(CUST, { addressUlid: 'A1' }))).toBe('409:OUT_OF_STOCK');
    expect(repo.orders).toHaveLength(0); // no order written
  });

  it('applies and records a promotion redemption', async () => {
    const repo = new FakeOrdersRepo();
    repo.promotionsByCode.set('SAVE10', promo());
    const { svc } = svcWith(repo);
    const order = await svc.createOrder(CUST, { addressUlid: 'A1', promoCode: 'save10' });
    expect(order.discountCents).toBe(3_020);
    expect(order.totalCents).toBe(42_180);
    expect(repo.redemptions).toHaveLength(1);
    expect([...repo.promotionsByCode.values()][0]?.totalRedeemed).toBe(1);
  });

  it('enforces the per-user promotion limit with 422 PROMO_USER_LIMIT', async () => {
    const repo = new FakeOrdersRepo();
    repo.promotionsByCode.set('SAVE10', promo({ perUserLimit: 1 }));
    repo.redemptions.push({ promotionId: 1, userId: 7, orderId: 999 }); // already used once
    const { svc } = svcWith(repo);
    expect(await thrown(svc.createOrder(CUST, { addressUlid: 'A1', promoCode: 'SAVE10' }))).toBe(
      '422:PROMO_USER_LIMIT',
    );
  });

  it('422s an empty cart and 404s an unknown address', async () => {
    const empty = new FakeOrdersRepo();
    empty.cart = { id: 1, userId: 7, merchantId: null };
    expect(await thrown(svcWith(empty).svc.createOrder(CUST, { addressUlid: 'A1' }))).toBe(
      '422:CART_EMPTY',
    );
    const noAddr = new FakeOrdersRepo();
    noAddr.address = null as never;
    expect(await thrown(svcWith(noAddr).svc.createOrder(CUST, { addressUlid: 'A1' }))).toBe(
      '404:NOT_FOUND',
    );
  });

  it('blocks an out-of-zone address with 422 OUT_OF_ZONE', async () => {
    const { svc } = svcWith(new FakeOrdersRepo(), {
      zones: { resolveZone: () => Promise.resolve(null) },
    });
    expect(await thrown(svc.createOrder(CUST, { addressUlid: 'A1' }))).toBe('422:OUT_OF_ZONE');
  });
});

describe('order service — cancelOrder', () => {
  it('cancels a draft: releases stock, reverses the promo, and records history', async () => {
    const repo = new FakeOrdersRepo();
    repo.promotionsByCode.set('SAVE10', promo());
    const { svc } = svcWith(repo);
    const created = await svc.createOrder(CUST, { addressUlid: 'A1', promoCode: 'SAVE10' });
    expect(repo.inventory.get(100)?.reserved).toBe(2);

    const cancelled = await svc.cancelOrder(CUST, created.ulid, 'changed my mind');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledReason).toBe('changed my mind');
    expect(repo.inventory.get(100)?.reserved).toBe(0); // released
    expect(repo.redemptions).toHaveLength(0); // reversed
    expect([...repo.promotionsByCode.values()][0]?.totalRedeemed).toBe(0);
    expect(repo.history.at(-1)).toMatchObject({ fromStatus: 'draft', toStatus: 'cancelled' });
  });

  it('404s a cancel by a different customer', async () => {
    const { repo, svc } = svcWith();
    const created = await svc.createOrder(CUST, { addressUlid: 'A1' });
    void repo;
    expect(await thrown(svc.cancelOrder(OTHER, created.ulid))).toBe('404:NOT_FOUND');
  });

  it('rejects cancelling a non-draft order with 409 ILLEGAL_TRANSITION', async () => {
    const { repo, svc } = svcWith();
    const created = await svc.createOrder(CUST, { addressUlid: 'A1' });
    const stored = repo.orders.find((o) => o.ulid === created.ulid)!;
    stored.status = 'delivered';
    expect(await thrown(svc.cancelOrder(CUST, created.ulid))).toBe('409:ILLEGAL_TRANSITION');
  });
});

describe('order service — reads', () => {
  it('gets and lists the customer’s own orders', async () => {
    const { svc } = svcWith();
    const created = await svc.createOrder(CUST, { addressUlid: 'A1' });
    expect((await svc.getOrder(CUST, created.ulid)).ulid).toBe(created.ulid);
    expect(await thrown(svc.getOrder(OTHER, created.ulid))).toBe('404:NOT_FOUND');
    const list = await svc.listOrders(CUST);
    expect(list).toHaveLength(1);
    expect(list[0]?.orderNumber).toBe(created.orderNumber);
  });
});
