import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuditService } from '../auth/audit-service';
import { createKnexAuthRepo } from '../auth/repo';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createCatalogueService } from '../catalogue/catalogue-service';
import { createKnexCatalogueRepo } from '../catalogue/repo';
import { createMerchantService } from '../merchant/merchant-service';
import { createKnexMerchantRepo } from '../merchant/repo';
import { createRequireAuth } from '../middleware/auth';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Merchant catalogue end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';
const OWNER_ULID = 'OWNER'.padEnd(26, '0');
const ownerToken = signAccessToken(
  { sub: OWNER_ULID, roles: ['merchant_owner'], jti: 'j' },
  { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
);

describe.skipIf(!DATABASE_URL)('catalogue integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let catalogueRepo: ReturnType<typeof createKnexCatalogueRepo>;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    catalogueRepo = createKnexCatalogueRepo(db);
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      merchant: {
        merchantService: createMerchantService({
          repo: createKnexMerchantRepo(db),
          auditService: createAuditService(createKnexAuthRepo(db)),
        }),
        catalogueService: createCatalogueService({ repo: catalogueRepo }),
        requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
      },
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });

  beforeEach(async () => {
    await db.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of [
      'inventory',
      'product_option',
      'product_option_group',
      'product',
      'category',
      'merchant_user',
      'merchant',
      'user_role',
      'user',
      'zone',
      'town',
    ]) {
      await db(table).truncate();
    }
    await db.raw('SET FOREIGN_KEY_CHECKS = 1');

    const [townId] = await db('town').insert({
      ulid: 'T1'.padEnd(26, '0'),
      name: 'Migori',
      is_active: true,
    });
    const [ownerId] = await db('user').insert({
      ulid: OWNER_ULID,
      phone_e164: '+254700000077',
      status: 'active',
    });
    const [merchantId] = await db('merchant').insert({
      ulid: 'MERCHANT'.padEnd(26, '0'),
      town_id: townId,
      name: 'Joe Kitchen',
      category_type: 'restaurant',
      status: 'approved',
      commission_bps: 1000,
    });
    await db('merchant_user').insert({ merchant_id: merchantId, user_id: ownerId, role: 'owner' });
  });

  it('creates category + product, edits with version bump, toggles availability', async () => {
    const cat = await request(app)
      .post('/api/v1/merchant/catalogue/categories')
      .set(auth())
      .send({ name: 'Mains' });
    expect(cat.status).toBe(201);

    const created = await request(app)
      .post('/api/v1/merchant/catalogue/products')
      .set(auth())
      .send({ categoryUlid: cat.body.ulid, name: 'Ugali', priceCents: 15000 });
    expect(created.status).toBe(201);
    expect(created.body.version).toBe(1);

    const edited = await request(app)
      .patch(`/api/v1/merchant/catalogue/products/${created.body.ulid}`)
      .set(auth())
      .send({ expectedVersion: 1, priceCents: 16000 });
    expect(edited.status).toBe(200);
    expect(edited.body.version).toBe(2);
    expect(edited.body.priceCents).toBe(16000);

    const avail = await request(app)
      .patch(`/api/v1/merchant/catalogue/products/${created.body.ulid}/availability`)
      .set(auth())
      .send({ isAvailable: false });
    expect(avail.status).toBe(200);
    expect(avail.body.isAvailable).toBe(false);

    const row = (await db('product').where({ ulid: created.body.ulid }).first()) as {
      price_cents: number;
      version: number;
      is_available: number;
    };
    expect(Number(row.price_cents)).toBe(16000);
    expect(Number(row.version)).toBe(2);
  });

  it('optimistic lock: two concurrent edits at the same version → exactly one wins (409 for the other)', async () => {
    const created = await request(app)
      .post('/api/v1/merchant/catalogue/products')
      .set(auth())
      .send({ name: 'Ugali', priceCents: 15000 });
    const ulid = created.body.ulid as string;

    const [a, b] = await Promise.all([
      request(app)
        .patch(`/api/v1/merchant/catalogue/products/${ulid}`)
        .set(auth())
        .send({ expectedVersion: 1, priceCents: 16000 }),
      request(app)
        .patch(`/api/v1/merchant/catalogue/products/${ulid}`)
        .set(auth())
        .send({ expectedVersion: 1, priceCents: 17000 }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const row = (await db('product').where({ ulid }).first()) as { version: number };
    expect(Number(row.version)).toBe(2); // exactly one edit applied
  });

  it('adds option groups + options and toggles option availability (real DB)', async () => {
    const created = await request(app)
      .post('/api/v1/merchant/catalogue/products')
      .set(auth())
      .send({ name: 'Pizza', priceCents: 50000 });
    expect(created.status).toBe(201);

    const group = await request(app)
      .post(`/api/v1/merchant/catalogue/products/${created.body.ulid}/option-groups`)
      .set(auth())
      .send({ name: 'Size', minSelect: 1, maxSelect: 1 });
    expect(group.status).toBe(201);

    const option = await request(app)
      .post(`/api/v1/merchant/catalogue/option-groups/${group.body.ulid}/options`)
      .set(auth())
      .send({ name: 'Large', priceDeltaCents: 10000 });
    expect(option.status).toBe(201);
    expect(option.body.isAvailable).toBe(true);

    const off = await request(app)
      .patch(`/api/v1/merchant/catalogue/options/${option.body.ulid}/availability`)
      .set(auth())
      .send({ isAvailable: false });
    expect(off.status).toBe(200);

    const row = (await db('product_option').where({ ulid: option.body.ulid }).first()) as {
      price_delta_cents: number;
      is_available: number;
    };
    expect(Number(row.price_delta_cents)).toBe(10000);
    expect(Number(row.is_available)).toBe(0);
  });

  it('inventory: set stock, then N concurrent reservations on 1 unit → exactly one wins', async () => {
    const created = await request(app)
      .post('/api/v1/merchant/catalogue/products')
      .set(auth())
      .send({ name: 'Scarce', priceCents: 1000 });
    expect(created.status).toBe(201);

    const set = await request(app)
      .put(`/api/v1/merchant/catalogue/products/${created.body.ulid}/inventory`)
      .set(auth())
      .send({ trackStock: true, quantity: 1 });
    expect(set.status).toBe(200);
    expect(set.body.quantity).toBe(1);

    const prow = (await db('product').where({ ulid: created.body.ulid }).first('id')) as {
      id: number | string;
    };
    const productId = Number(prow.id);

    // 10 concurrent single-unit reservations against 1 stock → exactly one succeeds.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => catalogueRepo.reserve(productId, 1)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);

    const inv = await catalogueRepo.getInventory(productId);
    expect(inv?.reserved).toBe(1);

    // release returns the unit.
    await catalogueRepo.release(productId, 1);
    expect((await catalogueRepo.getInventory(productId))?.reserved).toBe(0);
  });
});
