import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newUlid } from '../auth/crypto';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createCartService } from '../cart/cart-service';
import { createKnexCartRepo } from '../cart/repo';
import { createRequireAuth } from '../middleware/auth';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Cart end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

const P1 = 'P1'.padEnd(26, '0');
const P2 = 'P2'.padEnd(26, '0');
const Q1 = 'Q1'.padEnd(26, '0');
const O1 = 'O1'.padEnd(26, '0');
const O2 = 'O2'.padEnd(26, '0');
const OX = 'OX'.padEnd(26, '0');

describe.skipIf(!DATABASE_URL)('cart integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let custToken: string;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      cart: {
        cartService: createCartService({ repo: createKnexCartRepo(db) }),
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
      'cart_item',
      'cart',
      'product_option',
      'product_option_group',
      'product',
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

    const [townId] = await db('town').insert({ ulid: newUlid(), name: 'Migori', is_active: true });
    const custUlid = newUlid();
    await db('user').insert({ ulid: custUlid, phone_e164: '+254700000093', status: 'active' });
    custToken = signAccessToken(
      { sub: custUlid, roles: ['customer'], jti: 'j' },
      { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
    );

    const merchant = async (ulid: string, name: string) => {
      const [id] = await db('merchant').insert({
        ulid,
        town_id: townId,
        name,
        category_type: 'restaurant',
        status: 'approved',
        is_open: true,
        commission_bps: 1000,
      });
      return id as number;
    };
    const m1 = await merchant(newUlid(), 'Joe Kitchen');
    const m2 = await merchant(newUlid(), 'Mama Ntilie');

    const [p1] = await db('product').insert({
      ulid: P1,
      merchant_id: m1,
      name: 'Ugali',
      price_cents: 15_000,
      is_available: true,
    });
    await db('product').insert({
      ulid: P2,
      merchant_id: m1,
      name: 'Water',
      price_cents: 5_000,
      is_available: true,
    });
    await db('product').insert({
      ulid: Q1,
      merchant_id: m2,
      name: 'Rice',
      price_cents: 12_000,
      is_available: true,
    });

    const [groupId] = await db('product_option_group').insert({
      ulid: newUlid(),
      product_id: p1,
      name: 'Size',
      min_select: 1,
      max_select: 1,
    });
    await db('product_option').insert([
      {
        ulid: O1,
        option_group_id: groupId,
        name: 'Large',
        price_delta_cents: 100,
        is_available: true,
      },
      {
        ulid: O2,
        option_group_id: groupId,
        name: 'Small',
        price_delta_cents: 0,
        is_available: true,
      },
      {
        ulid: OX,
        option_group_id: groupId,
        name: 'Gone',
        price_delta_cents: 0,
        is_available: false,
      },
    ]);
  });

  const auth = () => ({ Authorization: `Bearer ${custToken}` });
  const add = (body: object) => request(app).post('/api/v1/cart/items').set(auth()).send(body);

  it('adds an item, persists the reference + options, and enriches the view', async () => {
    const res = await add({ productUlid: P1, quantity: 2, optionUlids: [O1] });
    expect(res.status).toBe(201);
    expect(res.body.merchant.name).toBe('Joe Kitchen');
    expect(res.body.items[0].product.name).toBe('Ugali');
    expect(res.body.items[0].options.map((o: { name: string }) => o.name)).toEqual(['Large']);

    const rows = await db('cart_item');
    expect(rows).toHaveLength(1);
  });

  it('enforces the single-merchant invariant (409)', async () => {
    await add({ productUlid: P1, quantity: 1, optionUlids: [O1] });
    const res = await add({ productUlid: Q1, quantity: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CART_MERCHANT_MISMATCH');
  });

  it('validates option selections against the product groups', async () => {
    expect((await add({ productUlid: P1, quantity: 1 })).status).toBe(400); // min 1 not met
    expect((await add({ productUlid: P1, quantity: 1, optionUlids: [O1, O2] })).status).toBe(400); // max 1
    expect((await add({ productUlid: P1, quantity: 1, optionUlids: [OX] })).status).toBe(400); // unavailable
  });

  it('merges identical lines and clears the merchant when emptied', async () => {
    await add({ productUlid: P1, quantity: 2, optionUlids: [O1] });
    const merged = await add({ productUlid: P1, quantity: 1, optionUlids: [O1] });
    expect(merged.body.items).toHaveLength(1);
    expect(merged.body.items[0].quantity).toBe(3);

    const itemUlid = merged.body.items[0].ulid as string;
    const removed = await request(app).delete(`/api/v1/cart/items/${itemUlid}`).set(auth());
    expect(removed.status).toBe(200);
    expect(removed.body.items).toEqual([]);
    expect(removed.body.merchant).toBeNull();

    const cartRow = (await db('cart').first('merchant_id')) as { merchant_id: number | null };
    expect(cartRow.merchant_id).toBeNull();
  });
});
