import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import { createLogger } from '../platform/logger';
import type { PromotionService, PromotionSummary } from '../promotions/promotion-service';

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

const summary: PromotionSummary = {
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
  startsAt: new Date('2026-01-01T00:00:00Z').toISOString(),
  endsAt: new Date('2026-12-31T00:00:00Z').toISOString(),
  isActive: true,
};

const promotionService: PromotionService = {
  createPromotion: () => Promise.resolve(summary),
  listPromotions: () => Promise.resolve([summary]),
  resolveDiscount: () => Promise.resolve({ promotion: {} as never, discountCents: 0 }),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    promotions: {
      promotionService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

const validBody = {
  code: 'SAVE10',
  type: 'percentage',
  valueBps: 1_000,
  startsAt: '2026-01-01T00:00:00Z',
  endsAt: '2026-12-31T00:00:00Z',
};

describe('admin promotions (RBAC = config:write / admin)', () => {
  it('creates a promotion for an admin (201)', async () => {
    const res = await request(app())
      .post('/api/v1/admin/promotions')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('SAVE10');
  });

  it('rejects unauthenticated (401) and non-admin (403)', async () => {
    expect((await request(app()).post('/api/v1/admin/promotions').send(validBody)).status).toBe(
      401,
    );
    for (const role of ['ops', 'customer']) {
      const res = await request(app())
        .post('/api/v1/admin/promotions')
        .set('Authorization', `Bearer ${tokenFor([role])}`)
        .send(validBody);
      expect(res.status).toBe(403);
    }
  });

  it('rejects an invalid body with 422', async () => {
    const res = await request(app())
      .post('/api/v1/admin/promotions')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send({
        code: 'X',
        type: 'bogus',
        startsAt: '2026-01-01T00:00:00Z',
        endsAt: '2026-02-01T00:00:00Z',
      });
    expect(res.status).toBe(422);
  });

  it('lists promotions for an admin (200)', async () => {
    const res = await request(app())
      .get('/api/v1/admin/promotions')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });
});
