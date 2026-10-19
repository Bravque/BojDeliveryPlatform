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
import { createKnexPricingRepo } from '../pricing/repo';
import { createQuoteService } from '../pricing/quote-service';
import { createKnexPromotionRepo } from '../promotions/repo';
import { createPromotionService } from '../promotions/promotion-service';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';
import { createKnexZoneRepo } from '../zones/repo';
import { createZoneService } from '../zones/zone-service';

/** Cart-quote end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

const CBD = { lat: -1.0634, lng: 34.4731 };
const NAIROBI = { lat: -1.2921, lng: 36.8219 };
const A_IN = 'A1'.padEnd(26, '0');
const A_OUT = 'A2'.padEnd(26, '0');

describe.skipIf(!DATABASE_URL)('cart quote integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let custToken: string;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    const auditService = createAuditService(createKnexAuthRepo(db));
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      pricing: {
        quoteService: createQuoteService({
          repo: createKnexPricingRepo(db),
          zones: createZoneService({ repo: createKnexZoneRepo(db), auditService }),
          fees: createFeeService({ repo: createKnexDeliveryFeeRuleRepo(db), auditService }),
          promotions: createPromotionService({ repo: createKnexPromotionRepo(db), auditService }),
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
      'promotion',
      'cart_item',
      'cart',
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
    const custUlid = newUlid();
    const [userId] = await db('user').insert({
      ulid: custUlid,
      phone_e164: '+254700000094',
      status: 'active',
    });
    custToken = signAccessToken(
      { sub: custUlid, roles: ['customer'], jti: 'j' },
      { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
    );

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
      per_km_cents: 0, // flat fee → deterministic regardless of distance
      min_fee_cents: 10_000,
      max_fee_cents: 20_000,
      effective_from: new Date('2020-01-01T00:00:00Z'),
      effective_to: null,
    });

    const [merchantId] = await db('merchant').insert({
      ulid: newUlid(),
      town_id: townId,
      name: 'Joe Kitchen',
      category_type: 'restaurant',
      status: 'approved',
      is_open: true,
      commission_bps: 1000,
      lat: CBD.lat,
      lng: CBD.lng,
    });
    const [productId] = await db('product').insert({
      ulid: newUlid(),
      merchant_id: merchantId,
      name: 'Ugali',
      price_cents: 15_000,
      is_available: true,
    });
    const [groupId] = await db('product_option_group').insert({
      ulid: newUlid(),
      product_id: productId,
      name: 'Size',
      min_select: 1,
      max_select: 1,
    });
    const optionUlid = 'O1'.padEnd(26, '0');
    await db('product_option').insert({
      ulid: optionUlid,
      option_group_id: groupId,
      name: 'Large',
      price_delta_cents: 100,
      is_available: true,
    });

    await db('address').insert([
      { ulid: A_IN, user_id: userId, line1: 'Market Rd', lat: CBD.lat, lng: CBD.lng },
      { ulid: A_OUT, user_id: userId, line1: 'Nairobi CBD', lat: NAIROBI.lat, lng: NAIROBI.lng },
    ]);

    const [cartId] = await db('cart').insert({ user_id: userId, merchant_id: merchantId });
    await db('cart_item').insert({
      ulid: newUlid(),
      cart_id: cartId,
      product_id: productId,
      quantity: 2,
      options_json: JSON.stringify([optionUlid]),
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

  const auth = () => ({ Authorization: `Bearer ${custToken}` });
  const quote = (body: object) => request(app).post('/api/v1/cart/quote').set(auth()).send(body);

  it('computes the authoritative breakdown for an in-zone address', async () => {
    const res = await quote({ addressUlid: A_IN });
    expect(res.status).toBe(200);
    expect(res.body.subtotalCents).toBe(30_200); // 2 × (15000 + 100)
    expect(res.body.deliveryFeeCents).toBe(10_000);
    expect(res.body.discountCents).toBe(0);
    expect(res.body.totalCents).toBe(40_200);
    expect(res.body.zone.name).toBe('Migori CBD');
  });

  it('applies a valid promotion code', async () => {
    const res = await quote({ addressUlid: A_IN, promoCode: 'save10' }); // case-insensitive
    expect(res.status).toBe(200);
    expect(res.body.discountCents).toBe(3_020); // 10% of 30200
    expect(res.body.totalCents).toBe(37_180);
    expect(res.body.promotion.code).toBe('SAVE10');
  });

  it('blocks an out-of-zone address with 422 OUT_OF_ZONE', async () => {
    const res = await quote({ addressUlid: A_OUT });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OUT_OF_ZONE');
  });

  it('422s an unknown promotion code', async () => {
    const res = await quote({ addressUlid: A_IN, promoCode: 'NOPE' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PROMO_NOT_FOUND');
  });
});
