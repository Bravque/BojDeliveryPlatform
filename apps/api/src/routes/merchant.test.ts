import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../auth/tokens';
import type { CatalogueService, ProductSummary } from '../catalogue/catalogue-service';
import type { MerchantService } from '../merchant/merchant-service';
import { createApp } from '../app';
import { conflict } from '../http/errors';
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

const product: ProductSummary = {
  ulid: 'P1',
  name: 'Ugali',
  description: null,
  priceCents: 15000,
  currency: 'KES',
  isAvailable: true,
  version: 1,
};

const merchantService: MerchantService = {
  createMerchant: () => Promise.reject(new Error('not used')),
  approveMerchant: () => Promise.reject(new Error('not used')),
  suspendMerchant: () => Promise.reject(new Error('not used')),
  addOwner: () => Promise.reject(new Error('not used')),
};

function appWith(catalogueService: CatalogueService) {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    merchant: {
      merchantService,
      catalogueService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

const happy: CatalogueService = {
  createCategory: () =>
    Promise.resolve({ ulid: 'C1', name: 'Mains', sortOrder: 0, isActive: true }),
  createProduct: () => Promise.resolve(product),
  editProduct: () => Promise.resolve({ ...product, version: 2 }),
  setAvailability: () => Promise.resolve({ ...product, isAvailable: false }),
  updateProfile: () => Promise.resolve({ merchantUlid: 'M1' }),
  addOptionGroup: () => Promise.resolve({ ulid: 'G1', name: 'Size', minSelect: 1, maxSelect: 1 }),
  addOption: () =>
    Promise.resolve({ ulid: 'O1', name: 'Large', priceDeltaCents: 10000, isAvailable: true }),
  setOptionAvailability: () => Promise.resolve({ ulid: 'O1', isAvailable: false }),
  setInventory: () => Promise.resolve({ trackStock: true, quantity: 5, reserved: 0 }),
};

const owner = () => tokenFor(['merchant_owner']);

describe('merchant catalogue routes (RBAC + validation)', () => {
  it('creates a category (201) for a merchant owner', async () => {
    const res = await request(appWith(happy))
      .post('/api/v1/merchant/catalogue/categories')
      .set('Authorization', `Bearer ${owner()}`)
      .send({ name: 'Mains' });
    expect(res.status).toBe(201);
    expect(res.body.ulid).toBe('C1');
  });

  it('creates a product (201)', async () => {
    const res = await request(appWith(happy))
      .post('/api/v1/merchant/catalogue/products')
      .set('Authorization', `Bearer ${owner()}`)
      .send({ name: 'Ugali', priceCents: 15000 });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe(1);
  });

  it('updates the profile (200)', async () => {
    const res = await request(appWith(happy))
      .patch('/api/v1/merchant/profile')
      .set('Authorization', `Bearer ${owner()}`)
      .send({ isOpen: true });
    expect(res.status).toBe(200);
  });

  it('forbids a customer (403)', async () => {
    const res = await request(appWith(happy))
      .post('/api/v1/merchant/catalogue/categories')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      .send({ name: 'Mains' });
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated request (401)', async () => {
    const res = await request(appWith(happy))
      .post('/api/v1/merchant/catalogue/categories')
      .send({ name: 'Mains' });
    expect(res.status).toBe(401);
  });

  it('rejects a product with no price (422)', async () => {
    const res = await request(appWith(happy))
      .post('/api/v1/merchant/catalogue/products')
      .set('Authorization', `Bearer ${owner()}`)
      .send({ name: 'Ugali' });
    expect(res.status).toBe(422);
  });

  it('rejects an empty profile update (422)', async () => {
    const res = await request(appWith(happy))
      .patch('/api/v1/merchant/profile')
      .set('Authorization', `Bearer ${owner()}`)
      .send({});
    expect(res.status).toBe(422);
  });

  it('maps a version conflict to 409', async () => {
    const failing: CatalogueService = {
      ...happy,
      editProduct: () => Promise.reject(conflict('VERSION_CONFLICT', 'stale')),
    };
    const res = await request(appWith(failing))
      .patch('/api/v1/merchant/catalogue/products/P1')
      .set('Authorization', `Bearer ${owner()}`)
      .send({ expectedVersion: 1, priceCents: 16000 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('adds an option group (201)', async () => {
    const res = await request(appWith(happy))
      .post('/api/v1/merchant/catalogue/products/P1/option-groups')
      .set('Authorization', `Bearer ${owner()}`)
      .send({ name: 'Size', minSelect: 1, maxSelect: 1 });
    expect(res.status).toBe(201);
    expect(res.body.ulid).toBe('G1');
  });

  it('adds an option (201)', async () => {
    const res = await request(appWith(happy))
      .post('/api/v1/merchant/catalogue/option-groups/G1/options')
      .set('Authorization', `Bearer ${owner()}`)
      .send({ name: 'Large', priceDeltaCents: 10000 });
    expect(res.status).toBe(201);
    expect(res.body.ulid).toBe('O1');
  });

  it('toggles option availability (200)', async () => {
    const res = await request(appWith(happy))
      .patch('/api/v1/merchant/catalogue/options/O1/availability')
      .set('Authorization', `Bearer ${owner()}`)
      .send({ isAvailable: false });
    expect(res.status).toBe(200);
    expect(res.body.isAvailable).toBe(false);
  });

  it('forbids a customer from adding an option group (403)', async () => {
    const res = await request(appWith(happy))
      .post('/api/v1/merchant/catalogue/products/P1/option-groups')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      .send({ name: 'Size' });
    expect(res.status).toBe(403);
  });

  it('rejects an option with no price delta (422)', async () => {
    const res = await request(appWith(happy))
      .post('/api/v1/merchant/catalogue/option-groups/G1/options')
      .set('Authorization', `Bearer ${owner()}`)
      .send({ name: 'Large' });
    expect(res.status).toBe(422);
  });

  it('sets inventory (200)', async () => {
    const res = await request(appWith(happy))
      .put('/api/v1/merchant/catalogue/products/P1/inventory')
      .set('Authorization', `Bearer ${owner()}`)
      .send({ trackStock: true, quantity: 5 });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(5);
  });

  it('rejects inventory with no quantity (422)', async () => {
    const res = await request(appWith(happy))
      .put('/api/v1/merchant/catalogue/products/P1/inventory')
      .set('Authorization', `Bearer ${owner()}`)
      .send({ trackStock: true });
    expect(res.status).toBe(422);
  });
});
