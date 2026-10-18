import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKnexBrowseRepo } from '../browse/repo';
import { createBrowseService } from '../browse/service';
import { createApp } from '../app';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Public catalogue browse end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const M1 = 'M1'.padEnd(26, '0'); // approved + open
const M2 = 'M2'.padEnd(26, '0'); // pending
const M3 = 'M3'.padEnd(26, '0'); // approved but closed
const P1 = 'P1'.padEnd(26, '0'); // available
const PX = 'PX'.padEnd(26, '0'); // unavailable

describe.skipIf(!DATABASE_URL)('public browse integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      browse: { browseService: createBrowseService({ repo: createKnexBrowseRepo(db) }) },
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

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
      'zone',
      'town',
    ]) {
      await db(table).truncate();
    }
    await db.raw('SET FOREIGN_KEY_CHECKS = 1');

    const [townId] = await db('town').insert({ name: 'Migori', is_active: true });
    const base = { town_id: townId, category_type: 'restaurant', commission_bps: 1000 };
    const [m1] = await db('merchant').insert({
      ...base,
      ulid: M1,
      name: 'Joe Kitchen',
      status: 'approved',
      is_open: true,
    });
    await db('merchant').insert({
      ...base,
      ulid: M2,
      name: 'Pending Shop',
      status: 'pending',
      is_open: true,
    });
    await db('merchant').insert({
      ...base,
      ulid: M3,
      name: 'Closed Cafe',
      status: 'approved',
      is_open: false,
    });

    const [catId] = await db('category').insert({
      ulid: 'C1'.padEnd(26, '0'),
      merchant_id: m1,
      name: 'Mains',
      sort_order: 0,
      is_active: true,
    });
    const [p1] = await db('product').insert({
      ulid: P1,
      merchant_id: m1,
      category_id: catId,
      name: 'Ugali',
      price_cents: 15000,
      is_available: true,
    });
    await db('product').insert({
      ulid: PX,
      merchant_id: m1,
      category_id: catId,
      name: 'Hidden',
      price_cents: 9999,
      is_available: false,
    });
    const [gId] = await db('product_option_group').insert({
      ulid: 'G1'.padEnd(26, '0'),
      product_id: p1,
      name: 'Size',
      min_select: 1,
      max_select: 1,
    });
    await db('product_option').insert({
      ulid: 'O1'.padEnd(26, '0'),
      option_group_id: gId,
      name: 'Large',
      price_delta_cents: 100,
      is_available: true,
    });
    await db('product_option').insert({
      ulid: 'OX'.padEnd(26, '0'),
      option_group_id: gId,
      name: 'HiddenOpt',
      price_delta_cents: 50,
      is_available: false,
    });
  });

  it('lists only approved + open merchants', async () => {
    const res = await request(app).get('/api/v1/merchants');
    expect(res.status).toBe(200);
    expect(res.body.items.map((m: { ulid: string }) => m.ulid)).toEqual([M1]);
  });

  it('returns towns and a merchant detail', async () => {
    const towns = await request(app).get('/api/v1/towns');
    expect(towns.body.items.map((t: { name: string }) => t.name)).toContain('Migori');

    const merchant = await request(app).get(`/api/v1/merchants/${M1}`);
    expect(merchant.status).toBe(200);
    expect(merchant.body.name).toBe('Joe Kitchen');

    const pending = await request(app).get(`/api/v1/merchants/${M2}`);
    expect(pending.status).toBe(404);
  });

  it('catalogue hides unavailable products and options', async () => {
    const res = await request(app).get(`/api/v1/merchants/${M1}/catalogue`);
    expect(res.status).toBe(200);
    const products = res.body.categories[0].products as { ulid: string; optionGroups: unknown[] }[];
    expect(products.map((p) => p.ulid)).toEqual([P1]); // PX (unavailable) excluded

    const options = (
      res.body.categories[0].products[0].optionGroups[0].options as {
        ulid: string;
      }[]
    ).map((o) => o.ulid);
    expect(options).toEqual(['O1'.padEnd(26, '0')]); // OX (unavailable) excluded
  });

  it('returns an available product, 404 for an unavailable one', async () => {
    expect((await request(app).get(`/api/v1/products/${P1}`)).status).toBe(200);
    expect((await request(app).get(`/api/v1/products/${PX}`)).status).toBe(404);
  });
});
