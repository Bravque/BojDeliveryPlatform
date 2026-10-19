import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../auth/tokens';
import type { CartService, CartView } from '../cart/cart-service';
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

const sampleCart: CartView = {
  merchant: { ulid: 'M1', name: 'Joe Kitchen' },
  items: [
    {
      ulid: 'CI1',
      product: {
        ulid: 'P1',
        name: 'Ugali',
        priceCents: 15_000,
        currency: 'KES',
        isAvailable: true,
      },
      quantity: 2,
      options: [{ ulid: 'O1', name: 'Large', priceDeltaCents: 100 }],
    },
  ],
};

const cartService: CartService = {
  getCart: () => Promise.resolve(sampleCart),
  addItem: () => Promise.resolve(sampleCart),
  updateQuantity: () => Promise.resolve(sampleCart),
  removeItem: () => Promise.resolve({ merchant: null, items: [] }),
  clearCart: () => Promise.resolve({ merchant: null, items: [] }),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    cart: {
      cartService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

const auth = () => ({ Authorization: `Bearer ${tokenFor(['customer'])}` });

describe('customer cart (auth required)', () => {
  it('rejects unauthenticated access with 401', async () => {
    expect((await request(app()).get('/api/v1/cart')).status).toBe(401);
    expect(
      (await request(app()).post('/api/v1/cart/items').send({ productUlid: 'P1', quantity: 1 }))
        .status,
    ).toBe(401);
  });

  it('gets the cart (200)', async () => {
    const res = await request(app()).get('/api/v1/cart').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items[0].product.ulid).toBe('P1');
  });

  it('adds an item (201)', async () => {
    const res = await request(app())
      .post('/api/v1/cart/items')
      .set(auth())
      .send({ productUlid: 'P1', quantity: 2, optionUlids: ['O1'] });
    expect(res.status).toBe(201);
    expect(res.body.merchant.ulid).toBe('M1');
  });

  it('rejects an invalid add body with 422', async () => {
    const res = await request(app())
      .post('/api/v1/cart/items')
      .set(auth())
      .send({ productUlid: 'P1', quantity: 0 }); // quantity must be >= 1
    expect(res.status).toBe(422);
  });

  it('updates quantity (200) and rejects quantity > 99 (422)', async () => {
    const ok = await request(app())
      .patch('/api/v1/cart/items/CI1')
      .set(auth())
      .send({ quantity: 3 });
    expect(ok.status).toBe(200);

    const bad = await request(app())
      .patch('/api/v1/cart/items/CI1')
      .set(auth())
      .send({ quantity: 100 });
    expect(bad.status).toBe(422);
  });

  it('removes an item and clears the cart (200)', async () => {
    const removed = await request(app()).delete('/api/v1/cart/items/CI1').set(auth());
    expect(removed.status).toBe(200);
    expect(removed.body.items).toEqual([]);

    const cleared = await request(app()).delete('/api/v1/cart').set(auth());
    expect(cleared.status).toBe(200);
    expect(cleared.body.merchant).toBeNull();
  });
});
