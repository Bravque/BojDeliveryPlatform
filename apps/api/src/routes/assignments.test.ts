import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AssignmentService } from '../delivery/assignment-service';
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

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    delivery: {
      assignmentService,
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
