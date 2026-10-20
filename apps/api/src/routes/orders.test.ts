import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import type { FulfillmentService, FulfillmentView } from '../orders/fulfillment-service';
import type { OrderService, OrderSummary, OrderView } from '../orders/order-service';
import { createLogger } from '../platform/logger';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

function tokenFor(roles: string[]): string {
  return signAccessToken(
    { sub: 'U1', roles, jti: 'jti-1' },
    { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
  );
}

const view: OrderView = {
  ulid: 'ORD1',
  orderNumber: 'BOJ-ABCDEF12',
  status: 'draft',
  paymentStatus: 'unpaid',
  merchant: { ulid: 'M1', name: 'Joe Kitchen' },
  currency: 'KES',
  items: [
    {
      productUlid: 'P1',
      name: 'Ugali',
      unitPriceCents: 15_000,
      quantity: 2,
      lineTotalCents: 30_200,
      options: [{ name: 'Large', priceDeltaCents: 100 }],
    },
  ],
  subtotalCents: 30_200,
  deliveryFeeCents: 15_000,
  serviceFeeCents: 0,
  discountCents: 0,
  totalCents: 45_200,
  commissionBps: 1_000,
  commissionCents: 3_020,
  distanceM: 1_200,
  cancelledReason: null,
  createdAt: new Date('2026-10-19T00:00:00Z').toISOString(),
};

const summary: OrderSummary = {
  ulid: 'ORD1',
  orderNumber: 'BOJ-ABCDEF12',
  status: 'draft',
  paymentStatus: 'unpaid',
  totalCents: 45_200,
  currency: 'KES',
  createdAt: view.createdAt,
};

const orderService: OrderService = {
  createOrder: () => Promise.resolve(view),
  cancelOrder: () => Promise.resolve({ ...view, status: 'cancelled', cancelledReason: 'x' }),
  getOrder: () => Promise.resolve(view),
  listOrders: () => Promise.resolve([summary]),
};

const fulfilled = (status: string): FulfillmentView => ({
  ulid: 'ORD1',
  orderNumber: 'BOJ-ABCDEF12',
  status,
  paymentStatus: 'paid',
});
const fulfillmentService: FulfillmentService = {
  acceptOrder: () => Promise.resolve(fulfilled('merchant_accepted')),
  startPreparing: () => Promise.resolve(fulfilled('preparing')),
  markReadyForPickup: () => Promise.resolve(fulfilled('ready_for_pickup')),
  rejectOrder: () => Promise.resolve(fulfilled('rejected')),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    orders: {
      orderService,
      fulfillmentService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

const auth = () => ({ Authorization: `Bearer ${tokenFor(['customer'])}` });

describe('customer orders (auth required)', () => {
  it('rejects unauthenticated access with 401', async () => {
    expect((await request(app()).post('/api/v1/orders').send({ addressUlid: 'A1' })).status).toBe(
      401,
    );
    expect((await request(app()).get('/api/v1/orders')).status).toBe(401);
  });

  it('creates an order (201)', async () => {
    const res = await request(app()).post('/api/v1/orders').set(auth()).send({ addressUlid: 'A1' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.totalCents).toBe(45_200);
  });

  it('rejects a missing addressUlid with 422', async () => {
    const res = await request(app()).post('/api/v1/orders').set(auth()).send({ promoCode: 'X' });
    expect(res.status).toBe(422);
  });

  it('lists and gets orders (200)', async () => {
    const list = await request(app()).get('/api/v1/orders').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);

    const got = await request(app()).get('/api/v1/orders/ORD1').set(auth());
    expect(got.status).toBe(200);
    expect(got.body.orderNumber).toBe('BOJ-ABCDEF12');
  });

  it('cancels an order (200)', async () => {
    const res = await request(app())
      .post('/api/v1/orders/ORD1/cancel')
      .set(auth())
      .send({ reason: 'changed my mind' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });
});

describe('merchant order progression (RBAC)', () => {
  const staffAuth = () => ({ Authorization: `Bearer ${tokenFor(['merchant_owner'])}` });

  it('forbids a customer accepting (403), allows merchant staff (200)', async () => {
    expect(
      (await request(app()).post('/api/v1/merchant/orders/ORD1/accept').set(auth())).status,
    ).toBe(403);
    const ok = await request(app()).post('/api/v1/merchant/orders/ORD1/accept').set(staffAuth());
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('merchant_accepted');
  });

  it('walks preparing → ready (200)', async () => {
    const prep = await request(app())
      .post('/api/v1/merchant/orders/ORD1/preparing')
      .set(staffAuth());
    expect(prep.status).toBe(200);
    expect(prep.body.status).toBe('preparing');
    const ready = await request(app()).post('/api/v1/merchant/orders/ORD1/ready').set(staffAuth());
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready_for_pickup');
  });

  it('rejects an order with a reason (200), requires the reason (422)', async () => {
    const ok = await request(app())
      .post('/api/v1/merchant/orders/ORD1/reject')
      .set(staffAuth())
      .send({ reason: 'out of stock' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('rejected');

    const bad = await request(app())
      .post('/api/v1/merchant/orders/ORD1/reject')
      .set(staffAuth())
      .send({});
    expect(bad.status).toBe(422);
  });
});
