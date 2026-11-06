import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newUlid } from '../auth/crypto';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createAuditService } from '../auth/audit-service';
import { createKnexAuthRepo } from '../auth/repo';
import { createCatalogueService } from '../catalogue/catalogue-service';
import { createKnexCatalogueRepo } from '../catalogue/repo';
import { createRequireAuth } from '../middleware/auth';
import { createFulfillmentService } from '../orders/fulfillment-service';
import { createKnexOrdersRepo } from '../orders/repo';
import type { OrderService } from '../orders/order-service';
import { createSettlementService } from '../settlements/settlement-service';
import { createKnexSettlementsRepo } from '../settlements/repo';
import type { MerchantService } from '../merchant/merchant-service';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/**
 * The merchant read API (`GET /merchant/{catalogue, orders/:ulid, settlements}`) end-to-end against a
 * real MySQL. Proves a merchant reads its OWN catalogue (incl. unavailable items + versions), order
 * detail (line items + options) and settlements — and is denied another merchant's. Self-skips
 * without DATABASE_URL.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

const merchantServiceStub = {
  createMerchant: () => Promise.reject(new Error('not used')),
  approveMerchant: () => Promise.reject(new Error('not used')),
  suspendMerchant: () => Promise.reject(new Error('not used')),
  setPayoutDestination: () => Promise.reject(new Error('not used')),
  addOwner: () => Promise.reject(new Error('not used')),
} as unknown as MerchantService;

const orderServiceStub = {
  createOrder: () => Promise.reject(new Error('not used')),
  cancelOrder: () => Promise.reject(new Error('not used')),
  getOrder: () => Promise.reject(new Error('not used')),
  listOrders: () => Promise.reject(new Error('not used')),
} as unknown as OrderService;

describe.skipIf(!DATABASE_URL)('merchant read API integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let townId: number;
  let zoneId: number;
  // Merchant A (the caller) + merchant B (the stranger).
  let merchantAId: number;
  let ownerAUlid: string;
  let ownerBUlid: string;
  let customerId: number;
  let addressId: number;
  let orderAUlid: string;
  let availableProductUlid: string;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    const auditService = createAuditService(createKnexAuthRepo(db));
    const withOrders = <T>(work: (repo: ReturnType<typeof createKnexOrdersRepo>) => Promise<T>) =>
      db.transaction((trx) => work(createKnexOrdersRepo(trx)));
    const withSettlements = <T>(
      work: (repo: ReturnType<typeof createKnexSettlementsRepo>) => Promise<T>,
    ) => db.transaction((trx) => work(createKnexSettlementsRepo(trx)));
    const requireAuth = createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE });
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      merchant: {
        merchantService: merchantServiceStub,
        catalogueService: createCatalogueService({ repo: createKnexCatalogueRepo(db) }),
        requireAuth,
      },
      orders: {
        orderService: orderServiceStub,
        fulfillmentService: createFulfillmentService({ withTransaction: withOrders }),
        requireAuth,
      },
      settlements: {
        settlementService: createSettlementService({
          withTransaction: withSettlements,
          auditService,
        }),
        requireAuth,
      },
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  /** Create a merchant + an owner user linked to it with the merchant_owner global role. */
  async function seedMerchant(name: string, phone: string): Promise<{ id: number; owner: string }> {
    const id = Number(
      (
        await db('merchant').insert({
          ulid: newUlid(),
          town_id: townId,
          name,
          category_type: 'restaurant',
          status: 'approved',
          is_open: true,
          commission_bps: 1_000,
        })
      )[0],
    );
    const owner = newUlid();
    const ownerId = Number(
      (await db('user').insert({ ulid: owner, phone_e164: phone, status: 'active' }))[0],
    );
    await db('merchant_user').insert({ merchant_id: id, user_id: ownerId, role: 'owner' });
    const ownerRole = (await db('role').where({ code: 'merchant_owner' }).first('id')) as {
      id: number | string;
    };
    await db('user_role').insert({ user_id: ownerId, role_id: ownerRole.id });
    return { id, owner };
  }

  beforeEach(async () => {
    await db.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of [
      'settlement_line',
      'settlement',
      'order_item_option',
      'order_item',
      'order_status_history',
      'order',
      'inventory',
      'product_option',
      'product_option_group',
      'product',
      'category',
      'merchant_user',
      'merchant',
      'address',
      'zone',
      'user_role',
      'user',
      'town',
    ]) {
      await db(table).truncate();
    }
    await db.raw('SET FOREIGN_KEY_CHECKS = 1');

    townId = Number(
      (await db('town').insert({ ulid: newUlid(), name: 'Migori', is_active: true }))[0],
    );
    zoneId = Number(
      (
        await db('zone').insert({
          ulid: newUlid(),
          town_id: townId,
          name: 'Migori CBD',
          center_lat: -1.0634,
          center_lng: 34.4731,
          radius_m: 3000,
          is_active: true,
        })
      )[0],
    );

    const a = await seedMerchant('Joe Kitchen', '+254700000181');
    merchantAId = a.id;
    ownerAUlid = a.owner;
    const b = await seedMerchant('Rival Cafe', '+254700000182');
    ownerBUlid = b.owner;

    customerId = Number(
      (
        await db('user').insert({ ulid: newUlid(), phone_e164: '+254700000180', status: 'active' })
      )[0],
    );
    addressId = Number(
      (
        await db('address').insert({
          ulid: newUlid(),
          user_id: customerId,
          line1: 'Market Rd',
          lat: -1.0634,
          lng: 34.4731,
        })
      )[0],
    );

    // Catalogue for merchant A: a category + an available product (with an option) + a hidden one.
    const categoryId = Number(
      (
        await db('category').insert({
          ulid: newUlid(),
          merchant_id: merchantAId,
          name: 'Mains',
          sort_order: 0,
        })
      )[0],
    );
    availableProductUlid = newUlid();
    const productId = Number(
      (
        await db('product').insert({
          ulid: availableProductUlid,
          merchant_id: merchantAId,
          category_id: categoryId,
          name: 'Pizza',
          price_cents: 50_000,
          is_available: true,
        })
      )[0],
    );
    await db('product').insert({
      ulid: newUlid(),
      merchant_id: merchantAId,
      category_id: categoryId,
      name: 'Hidden Special',
      price_cents: 20_000,
      is_available: false,
    });
    await db('inventory').insert({ product_id: productId, track_stock: true, quantity: 7 });
    const groupId = Number(
      (
        await db('product_option_group').insert({
          ulid: newUlid(),
          product_id: productId,
          name: 'Size',
          min_select: 1,
          max_select: 1,
        })
      )[0],
    );
    await db('product_option').insert({
      ulid: newUlid(),
      option_group_id: groupId,
      name: 'Large',
      price_delta_cents: 10_000,
      is_available: true,
    });

    // A placed order for merchant A with one line (qty 2) + a chosen option.
    orderAUlid = newUlid();
    const orderId = Number(
      (
        await db('order').insert({
          ulid: orderAUlid,
          order_number: `BOJ-${orderAUlid.slice(-6)}`,
          customer_id: customerId,
          merchant_id: merchantAId,
          town_id: townId,
          zone_id: zoneId,
          delivery_address_id: addressId,
          status: 'placed',
          payment_status: 'paid',
          subtotal_cents: 110_000,
          delivery_fee_cents: 10_000,
          total_cents: 120_000,
          commission_bps: 1_000,
          commission_cents: 11_000,
        })
      )[0],
    );
    const orderItemId = Number(
      (
        await db('order_item').insert({
          order_id: orderId,
          product_id: productId,
          name_snapshot: 'Pizza',
          unit_price_cents: 50_000,
          quantity: 2,
          line_total_cents: 120_000,
        })
      )[0],
    );
    await db('order_item_option').insert({
      order_item_id: orderItemId,
      name_snapshot: 'Large',
      price_delta_cents: 10_000,
    });

    // A settlement for merchant A.
    await db('settlement').insert({
      ulid: newUlid(),
      merchant_id: merchantAId,
      period_start: '2026-10-01',
      period_end: '2026-10-07',
      gross_cents: 110_000,
      commission_cents: 11_000,
      refunds_cents: 0,
      net_cents: 99_000,
      status: 'approved',
    });
  });

  const authFor = (ulid: string) => ({
    Authorization: `Bearer ${signAccessToken(
      { sub: ulid, roles: ['merchant_owner'], jti: 'j' },
      { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
    )}`,
  });

  it('GET /merchant/catalogue returns own products incl. unavailable, with version + inventory + options', async () => {
    const res = await request(app).get('/api/v1/merchant/catalogue').set(authFor(ownerAUlid));
    expect(res.status).toBe(200);
    expect(res.body.categories.map((c: { name: string }) => c.name)).toContain('Mains');
    const names = res.body.products.map((p: { name: string }) => p.name);
    expect(names).toContain('Pizza');
    expect(names).toContain('Hidden Special'); // unavailable still shown for management

    const pizza = res.body.products.find((p: { name: string }) => p.name === 'Pizza');
    expect(pizza.version).toBe(1);
    expect(pizza.inventory).toMatchObject({ trackStock: true, quantity: 7, reserved: 0 });
    expect(pizza.optionGroups[0].name).toBe('Size');
    expect(pizza.optionGroups[0].options[0]).toMatchObject({
      name: 'Large',
      priceDeltaCents: 10_000,
    });
  });

  it('GET /merchant/orders/:ulid returns the order detail with items + options', async () => {
    const res = await request(app)
      .get(`/api/v1/merchant/orders/${orderAUlid}`)
      .set(authFor(ownerAUlid));
    expect(res.status).toBe(200);
    expect(res.body.orderNumber).toBe(`BOJ-${orderAUlid.slice(-6)}`);
    expect(res.body.totalCents).toBe(120_000);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ name: 'Pizza', quantity: 2 });
    expect(res.body.items[0].options[0]).toEqual({ name: 'Large', priceDeltaCents: 10_000 });
  });

  it('GET /merchant/settlements returns only the caller merchant’s settlements', async () => {
    const a = await request(app).get('/api/v1/merchant/settlements').set(authFor(ownerAUlid));
    expect(a.status).toBe(200);
    expect(a.body.items).toHaveLength(1);
    expect(a.body.items[0]).toMatchObject({ netCents: 99_000, status: 'approved' });

    // Merchant B has no settlements → empty list (and definitely not A's).
    const b = await request(app).get('/api/v1/merchant/settlements').set(authFor(ownerBUlid));
    expect(b.status).toBe(200);
    expect(b.body.items).toHaveLength(0);
  });

  it('denies a different merchant’s owner the order detail (403) and hides A’s catalogue from B', async () => {
    const detail = await request(app)
      .get(`/api/v1/merchant/orders/${orderAUlid}`)
      .set(authFor(ownerBUlid));
    expect(detail.status).toBe(403);

    const catalogue = await request(app).get('/api/v1/merchant/catalogue').set(authFor(ownerBUlid));
    expect(catalogue.status).toBe(200);
    expect(catalogue.body.products).toHaveLength(0); // B owns no products
  });
});
