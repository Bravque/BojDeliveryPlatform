import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import type { QuoteBreakdown, QuoteService } from '../pricing/quote-service';
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

const breakdown: QuoteBreakdown = {
  merchant: { ulid: 'M1', name: 'Joe Kitchen' },
  zone: { ulid: 'Z1', name: 'CBD' },
  distanceM: 1_200,
  currency: 'KES',
  items: [
    {
      productUlid: 'P1',
      name: 'Ugali',
      unitPriceCents: 15_000,
      quantity: 2,
      optionsCents: 100,
      lineTotalCents: 30_200,
      options: [{ ulid: 'O1', name: 'Large', priceDeltaCents: 100 }],
    },
  ],
  subtotalCents: 30_200,
  deliveryFeeCents: 15_000,
  serviceFeeCents: 0,
  discountCents: 0,
  totalCents: 45_200,
  promotion: null,
};

const quoteService: QuoteService = {
  quote: () => Promise.resolve(breakdown),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    pricing: {
      quoteService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

describe('POST /api/v1/cart/quote', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app()).post('/api/v1/cart/quote').send({ addressUlid: 'A1' });
    expect(res.status).toBe(401);
  });

  it('returns the breakdown for an authenticated customer (200)', async () => {
    const res = await request(app())
      .post('/api/v1/cart/quote')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      .send({ addressUlid: 'A1' });
    expect(res.status).toBe(200);
    expect(res.body.totalCents).toBe(45_200);
    expect(res.body.items[0].productUlid).toBe('P1');
  });

  it('rejects a missing addressUlid with 422', async () => {
    const res = await request(app())
      .post('/api/v1/cart/quote')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      .send({ promoCode: 'SAVE10' });
    expect(res.status).toBe(422);
  });
});
