import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AssignmentService } from '../delivery/assignment-service';
import type { DeliveryService } from '../delivery/delivery-service';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
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

const assignmentService: AssignmentService = {
  offerForOrder: () => Promise.resolve({ offered: true, offerId: 1, riderId: 10 }),
  acceptOffer: () =>
    Promise.resolve({
      orderUlid: 'ORD1',
      status: 'rider_assigned',
      deliveryId: 1,
      riderFeeCents: 7_000,
    }),
  declineOffer: () => Promise.resolve({ offered: true, offerId: 2, riderId: 11 }),
  listOffers: () =>
    Promise.resolve([{ offerId: 1, orderUlid: 'ORD1', expiresAt: '2026-10-20T00:00:00.000Z' }]),
  tick: () => Promise.resolve({ expired: 0, scanned: 0, offered: 0 }),
};

const deliveryView = {
  orderUlid: 'ORD1',
  orderStatus: 'picked_up',
  deliveryStatus: 'picked_up',
  riderFeeCents: 7_000,
};
const deliveryService: DeliveryService = {
  confirmPickup: () => Promise.resolve(deliveryView),
  startDelivery: () => Promise.resolve({ ...deliveryView, orderStatus: 'out_for_delivery' }),
  issueDeliveryPin: () => Promise.resolve({ pin: '1234' }),
  completeDelivery: () =>
    Promise.resolve({ ...deliveryView, orderStatus: 'delivered', deliveryStatus: 'delivered' }),
  completeDeliveryOverride: () =>
    Promise.resolve({ ...deliveryView, orderStatus: 'delivered', deliveryStatus: 'delivered' }),
  getDelivery: () => Promise.resolve(deliveryView),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    delivery: {
      assignmentService,
      deliveryService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

describe('rider offers (RBAC)', () => {
  it('lists offers for a rider (200), forbids a customer (403)', async () => {
    expect(
      (
        await request(app())
          .get('/api/v1/rider/offers')
          .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .get('/api/v1/rider/offers')
      .set('Authorization', `Bearer ${tokenFor(['rider'])}`);
    expect(ok.status).toBe(200);
    expect(ok.body.items).toHaveLength(1);
  });

  it('accepts an offer (200)', async () => {
    const res = await request(app())
      .post('/api/v1/rider/offers/1/accept')
      .set('Authorization', `Bearer ${tokenFor(['rider'])}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rider_assigned');
  });

  it('rejects a non-numeric offer id (422)', async () => {
    const res = await request(app())
      .post('/api/v1/rider/offers/abc/accept')
      .set('Authorization', `Bearer ${tokenFor(['rider'])}`);
    expect(res.status).toBe(422);
  });

  it('declines an offer (200 → next offer)', async () => {
    const res = await request(app())
      .post('/api/v1/rider/offers/1/decline')
      .set('Authorization', `Bearer ${tokenFor(['rider'])}`);
    expect(res.status).toBe(200);
    expect(res.body.offered).toBe(true);
  });
});

describe('admin assignment tick (RBAC)', () => {
  it('forbids a rider (403), allows ops (200)', async () => {
    expect(
      (
        await request(app())
          .post('/api/v1/admin/assignments/tick')
          .set('Authorization', `Bearer ${tokenFor(['rider'])}`)
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/admin/assignments/tick')
      .set('Authorization', `Bearer ${tokenFor(['ops'])}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ expired: 0, offered: 0 });
  });
});

describe('delivery execution (RBAC + validation)', () => {
  it('rider pickup/start (200), forbids a customer (403)', async () => {
    expect(
      (
        await request(app())
          .post('/api/v1/rider/deliveries/ORD1/pickup')
          .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/rider/deliveries/ORD1/pickup')
      .set('Authorization', `Bearer ${tokenFor(['rider'])}`);
    expect(ok.status).toBe(200);
    expect(ok.body.orderStatus).toBe('picked_up');
  });

  it('complete requires a pin (422), completes with one (200 → delivered)', async () => {
    const bad = await request(app())
      .post('/api/v1/rider/deliveries/ORD1/complete')
      .set('Authorization', `Bearer ${tokenFor(['rider'])}`)
      .send({});
    expect(bad.status).toBe(422);

    const ok = await request(app())
      .post('/api/v1/rider/deliveries/ORD1/complete')
      .set('Authorization', `Bearer ${tokenFor(['rider'])}`)
      .send({ pin: '1234' });
    expect(ok.status).toBe(200);
    expect(ok.body.orderStatus).toBe('delivered');
  });

  it('customer issues a delivery PIN (200)', async () => {
    const res = await request(app())
      .post('/api/v1/orders/ORD1/delivery-pin')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`);
    expect(res.status).toBe(200);
    expect(res.body.pin).toBe('1234');
  });

  it('admin override-complete (200), forbids a rider (403)', async () => {
    expect(
      (
        await request(app())
          .post('/api/v1/admin/deliveries/ORD1/override-complete')
          .set('Authorization', `Bearer ${tokenFor(['rider'])}`)
          .send({ reason: 'customer unreachable' })
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/admin/deliveries/ORD1/override-complete')
      .set('Authorization', `Bearer ${tokenFor(['ops'])}`)
      .send({ reason: 'customer unreachable' });
    expect(ok.status).toBe(200);
    expect(ok.body.orderStatus).toBe('delivered');
  });
});
