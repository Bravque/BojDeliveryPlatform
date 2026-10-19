import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuditService } from '../auth/audit-service';
import { newUlid } from '../auth/crypto';
import { createKnexAuthRepo } from '../auth/repo';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createFeeService } from '../fees/fee-service';
import { createKnexDeliveryFeeRuleRepo } from '../fees/repo';
import { createRequireAuth } from '../middleware/auth';
import { createFulfillmentService } from '../orders/fulfillment-service';
import { createOrderService } from '../orders/order-service';
import { createKnexOrdersRepo } from '../orders/repo';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';
import { createKnexZoneRepo } from '../zones/repo';
import { createZoneService } from '../zones/zone-service';

/** Order creation + cancel + checkout concurrency against a real MySQL. Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';
const CBD = { lat: -1.0634, lng: 34.4731 };

describe.skipIf(!DATABASE_URL)('orders integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let merchantId: number;
  let productId: number;
  let optionUlid: string;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    const auditService = createAuditService(createKnexAuthRepo(db));
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      orders: {
        orderService: createOrderService({
          readRepo: createKnexOrdersRepo(db),
          withTransaction: (work) => db.transaction((trx) => work(createKnexOrdersRepo(trx))),
          zones: createZoneService({ repo: createKnexZoneRepo(db), auditService }),
          fees: createFeeService({ repo: createKnexDeliveryFeeRuleRepo(db), auditService }),
        }),
        fulfillmentService: createFulfillmentService({
          withTransaction: (work) => db.transaction((trx) => work(createKnexOrdersRepo(trx))),
        }),
        requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
      },
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of [
      'promotion_redemption',
      'order_status_history',
      'order_item_option',
      'order_item',
      'order',
      'promotion',
      'cart_item',
      'cart',
      'inventory',
      'product_option',
      'product_option_group',
      'product',
      'delivery_fee_rule',
      'address',
      'merchant_user',
      'merchant',
      'zone',
      'user_role',
      'user',
      'town',
    ]) {
      await db(table).truncate();
    }
    await db.raw('SET FOREIGN_KEY_CHECKS = 1');

    const [townId] = await db('town').insert({ ulid: newUlid(), name: 'Migori', is_active: true });
    const [zoneId] = await db('zone').insert({
      ulid: newUlid(),
      town_id: townId,
      name: 'Migori CBD',
      center_lat: CBD.lat,
      center_lng: CBD.lng,
      radius_m: 3000,
      is_active: true,
    });
    await db('delivery_fee_rule').insert({
      ulid: newUlid(),
      zone_id: zoneId,
      base_fee_cents: 10_000,
      per_km_cents: 0,
      min_fee_cents: 10_000,
      max_fee_cents: 20_000,
      effective_from: new Date('2020-01-01T00:00:00Z'),
      effective_to: null,
    });
    const merchantInsert = await db('merchant').insert({
      ulid: newUlid(),
      town_id: townId,
      name: 'Joe Kitchen',
      category_type: 'restaurant',
      status: 'approved',
      is_open: true,
      commission_bps: 1_000,
      lat: CBD.lat,
      lng: CBD.lng,
    });
    merchantId = Number(merchantInsert[0]);
    const productInsert = await db('product').insert({
      ulid: newUlid(),
      merchant_id: merchantId,
      name: 'Ugali',
      price_cents: 15_000,
      is_available: true,
    });
    productId = Number(productInsert[0]);
    await db('inventory').insert({
      product_id: productId,
      track_stock: true,
      quantity: 10,
      reserved: 0,
    });
    const [groupId] = await db('product_option_group').insert({
      ulid: newUlid(),
      product_id: productId,
      name: 'Size',
      min_select: 0,
      max_select: 1,
    });
    optionUlid = newUlid();
    await db('product_option').insert({
      ulid: optionUlid,
      option_group_id: groupId,
      name: 'Large',
      price_delta_cents: 100,
      is_available: true,
    });
    await db('promotion').insert({
      ulid: newUlid(),
      code: 'SAVE10',
      type: 'percentage',
      value_bps: 1_000,
      min_subtotal_cents: 0,
      per_user_limit: 1,
      starts_at: new Date('2020-01-01T00:00:00Z'),
      ends_at: new Date('2999-01-01T00:00:00Z'),
      is_active: true,
    });
  });

  async function makeCustomer(
    phone: string,
  ): Promise<{ userId: number; token: string; addressUlid: string }> {
    const ulid = newUlid();
    const [userId] = await db('user').insert({ ulid, phone_e164: phone, status: 'active' });
    const token = signAccessToken(
      { sub: ulid, roles: ['customer'], jti: 'j' },
      { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
    );
    const addressUlid = newUlid();
    await db('address').insert({
      ulid: addressUlid,
      user_id: userId,
      line1: 'Market Rd',
      lat: CBD.lat,
      lng: CBD.lng,
    });
    return { userId: Number(userId), token, addressUlid };
  }

  async function giveCart(userId: number, quantity: number, withOption: boolean): Promise<void> {
    await db('cart')
      .insert({ user_id: userId, merchant_id: merchantId })
      .onConflict('user_id')
      .merge({
        merchant_id: merchantId,
      });
    const cart = (await db('cart').where({ user_id: userId }).first('id')) as { id: number };
    await db('cart_item').insert({
      ulid: newUlid(),
      cart_id: cart.id,
      product_id: productId,
      quantity,
      options_json: withOption ? JSON.stringify([optionUlid]) : null,
    });
  }

  it('creates a draft order: price snapshot, stock reservation, cart consumed, history', async () => {
    const cust = await makeCustomer('+254700000101');
    await giveCart(cust.userId, 2, true);

    const res = await request(app)
      .post('/api/v1/orders')
      .set({ Authorization: `Bearer ${cust.token}` })
      .send({ addressUlid: cust.addressUlid });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.subtotalCents).toBe(30_200); // 2 × (15000 + 100)
    expect(res.body.deliveryFeeCents).toBe(10_000);
    expect(res.body.totalCents).toBe(40_200);
    expect(res.body.commissionCents).toBe(3_020);

    const orderRow = (await db('order').where({ ulid: res.body.ulid }).first()) as { id: number };
    expect(await db('order_item').where({ order_id: orderRow.id })).toHaveLength(1);
    expect(await db('order_item_option')).toHaveLength(1);
    const history = await db('order_status_history').where({ order_id: orderRow.id });
    expect(history).toHaveLength(1);
    expect(history[0]?.to_status).toBe('draft');

    const inv = (await db('inventory').where({ product_id: productId }).first()) as {
      reserved: number;
    };
    expect(Number(inv.reserved)).toBe(2);
    expect(await db('cart_item')).toHaveLength(0); // cart consumed
  });

  it('redeems a promotion and enforces the per-user limit on a second order', async () => {
    const cust = await makeCustomer('+254700000102');
    await giveCart(cust.userId, 1, false);
    const first = await request(app)
      .post('/api/v1/orders')
      .set({ Authorization: `Bearer ${cust.token}` })
      .send({ addressUlid: cust.addressUlid, promoCode: 'save10' });
    expect(first.status).toBe(201);
    expect(first.body.discountCents).toBe(1_500); // 10% of 15000
    expect(first.body.totalCents).toBe(23_500); // 15000 + 10000 - 1500
    expect(await db('promotion_redemption')).toHaveLength(1);
    const promoRow = (await db('promotion').where({ code: 'SAVE10' }).first()) as {
      total_redeemed: number;
    };
    expect(Number(promoRow.total_redeemed)).toBe(1);

    await giveCart(cust.userId, 1, false); // new cart, same user
    const second = await request(app)
      .post('/api/v1/orders')
      .set({ Authorization: `Bearer ${cust.token}` })
      .send({ addressUlid: cust.addressUlid, promoCode: 'SAVE10' });
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('PROMO_USER_LIMIT');
  });

  it('cancels a draft order: releases stock, writes history', async () => {
    const cust = await makeCustomer('+254700000103');
    await giveCart(cust.userId, 2, false);
    const created = await request(app)
      .post('/api/v1/orders')
      .set({ Authorization: `Bearer ${cust.token}` })
      .send({ addressUlid: cust.addressUlid });
    expect(created.status).toBe(201);

    const cancelled = await request(app)
      .post(`/api/v1/orders/${created.body.ulid}/cancel`)
      .set({ Authorization: `Bearer ${cust.token}` })
      .send({ reason: 'changed my mind' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');

    const inv = (await db('inventory').where({ product_id: productId }).first()) as {
      reserved: number;
    };
    expect(Number(inv.reserved)).toBe(0); // released
    const history = await db('order_status_history').where({ to_status: 'cancelled' }).first();
    expect(history).toBeTruthy();
  });

  it('acceptance: N concurrent checkouts on 1 stock → exactly one succeeds', async () => {
    await db('inventory').where({ product_id: productId }).update({ quantity: 1, reserved: 0 });

    const n = 5;
    const customers = await Promise.all(
      Array.from({ length: n }, (_, i) => makeCustomer(`+2547010001${10 + i}`)),
    );
    for (const c of customers) {
      await giveCart(c.userId, 1, false);
    }

    const results = await Promise.all(
      customers.map((c) =>
        request(app)
          .post('/api/v1/orders')
          .set({ Authorization: `Bearer ${c.token}` })
          .send({ addressUlid: c.addressUlid }),
      ),
    );

    const created = results.filter((r) => r.status === 201).length;
    const outOfStock = results.filter(
      (r) => r.status === 409 && r.body.error.code === 'OUT_OF_STOCK',
    ).length;
    expect(created).toBe(1);
    expect(outOfStock).toBe(n - 1);

    const inv = (await db('inventory').where({ product_id: productId }).first()) as {
      reserved: number;
    };
    expect(Number(inv.reserved)).toBe(1);
    expect(await db('order')).toHaveLength(1);
  });
});
