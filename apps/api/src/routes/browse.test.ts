import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { BrowseService } from '../browse/service';
import { createApp } from '../app';
import { notFound } from '../http/errors';
import { createLogger } from '../platform/logger';

const merchant = {
  ulid: 'M1',
  name: 'Joe Kitchen',
  categoryType: 'restaurant',
  prepMinutes: 20,
  isOpen: true,
  townName: 'Migori',
};

const browseService: BrowseService = {
  listTowns: () => Promise.resolve([{ name: 'Migori', timezone: 'Africa/Nairobi' }]),
  listMerchants: () => Promise.resolve([merchant]),
  getMerchant: (ulid) =>
    ulid === 'M1' ? Promise.resolve(merchant) : Promise.reject(notFound('Merchant not found')),
  getMerchantCatalogue: () =>
    Promise.resolve({ merchant, categories: [], uncategorizedProducts: [] }),
  getProduct: (ulid) =>
    ulid === 'P1'
      ? Promise.resolve({
          ulid: 'P1',
          name: 'Ugali',
          description: null,
          priceCents: 15000,
          currency: 'KES',
          optionGroups: [],
          merchantUlid: 'M1',
        })
      : Promise.reject(notFound('Product not found')),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    browse: { browseService },
  });
}

describe('public browse routes (no auth)', () => {
  it('GET /towns returns the list without a token', async () => {
    const res = await request(app()).get('/api/v1/towns');
    expect(res.status).toBe(200);
    expect(res.body.items[0].name).toBe('Migori');
  });

  it('GET /merchants returns approved/open merchants', async () => {
    const res = await request(app()).get('/api/v1/merchants?townName=Migori');
    expect(res.status).toBe(200);
    expect(res.body.items[0].ulid).toBe('M1');
  });

  it('GET /merchants/:ulid returns a merchant, 404 for unknown', async () => {
    expect((await request(app()).get('/api/v1/merchants/M1')).status).toBe(200);
    const miss = await request(app()).get('/api/v1/merchants/ghost');
    expect(miss.status).toBe(404);
    expect(miss.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /merchants/:ulid/catalogue returns a catalogue', async () => {
    const res = await request(app()).get('/api/v1/merchants/M1/catalogue');
    expect(res.status).toBe(200);
    expect(res.body.merchant.ulid).toBe('M1');
  });

  it('GET /products/:ulid returns a product, 404 for unavailable', async () => {
    expect((await request(app()).get('/api/v1/products/P1')).status).toBe(200);
    expect((await request(app()).get('/api/v1/products/nope')).status).toBe(404);
  });
});
