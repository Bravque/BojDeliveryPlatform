import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAddressService } from '../addresses/address-service';
import { createKnexAddressRepo } from '../addresses/repo';
import { createAuditService } from '../auth/audit-service';
import { newUlid } from '../auth/crypto';
import { createKnexAuthRepo } from '../auth/repo';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createFeeService, type FeeService } from '../fees/fee-service';
import { createKnexDeliveryFeeRuleRepo } from '../fees/repo';
import { createRequireAuth } from '../middleware/auth';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';
import { createKnexZoneRepo } from '../zones/repo';
import { createZoneService } from '../zones/zone-service';

/** Delivery-fee rules end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';
const adminToken = signAccessToken(
  { sub: 'ADMIN', roles: ['admin'], jti: 'j' },
  { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
);

const CBD = { centerLat: -1.0634, centerLng: 34.4731, radiusM: 3000 };

describe.skipIf(!DATABASE_URL)('delivery-fee rules integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let feeService: FeeService;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    const auditService = createAuditService(createKnexAuthRepo(db));
    const zoneService = createZoneService({ repo: createKnexZoneRepo(db), auditService });
    feeService = createFeeService({ repo: createKnexDeliveryFeeRuleRepo(db), auditService });
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      geo: {
        zoneService,
        addressService: createAddressService({ repo: createKnexAddressRepo(db), zoneService }),
        requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
      },
      fees: {
        feeService,
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
      'audit_log',
      'delivery_fee_rule',
      'address',
      'zone',
      'town',
      'user_role',
      'user',
    ]) {
      await db(table).truncate();
    }
    await db.raw('SET FOREIGN_KEY_CHECKS = 1');
    await db('town').insert({ ulid: newUlid(), name: 'Migori', is_active: true });
  });

  const adminAuth = () => ({ Authorization: `Bearer ${adminToken}` });

  async function createZone(name: string) {
    const res = await request(app)
      .post('/api/v1/admin/zones')
      .set(adminAuth())
      .send({ townName: 'Migori', name, ...CBD, isActive: true });
    expect(res.status).toBe(201);
    return res.body.ulid as string;
  }

  it('creates and lists a fee rule under a zone, and persists the cents', async () => {
    const zoneUlid = await createZone('Migori CBD');
    const created = await request(app)
      .post(`/api/v1/admin/zones/${zoneUlid}/fee-rules`)
      .set(adminAuth())
      .send({ baseFeeCents: 10_000, perKmCents: 2_000, minFeeCents: 10_000, maxFeeCents: 20_000 });
    expect(created.status).toBe(201);

    const row = (await db('delivery_fee_rule').where({ ulid: created.body.ulid }).first()) as {
      base_fee_cents: number;
      per_km_cents: number;
    };
    expect(Number(row.base_fee_cents)).toBe(10_000);
    expect(Number(row.per_km_cents)).toBe(2_000);

    const list = await request(app)
      .get(`/api/v1/admin/zones/${zoneUlid}/fee-rules`)
      .set(adminAuth());
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
  });

  it('prices delivery with the effective rule, and returns null for a zone without one', async () => {
    const zoneUlid = await createZone('Priced');
    await request(app)
      .post(`/api/v1/admin/zones/${zoneUlid}/fee-rules`)
      .set(adminAuth())
      .send({ baseFeeCents: 10_000, perKmCents: 2_000, minFeeCents: 10_000, maxFeeCents: 20_000 });

    const priced = (await db('zone').where({ ulid: zoneUlid }).first('id')) as { id: number };
    const quote = await feeService.resolveFee(Number(priced.id), 3_000);
    expect(quote?.feeCents).toBe(16_000); // 10000 + 2000 * 3km

    // A different zone with no rule yields no quote.
    const unpricedUlid = await createZone('Unpriced');
    const unpriced = (await db('zone').where({ ulid: unpricedUlid }).first('id')) as { id: number };
    expect(await feeService.resolveFee(Number(unpriced.id), 3_000)).toBeNull();
  });

  it('forbids a non-admin from creating a fee rule (403)', async () => {
    const zoneUlid = await createZone('Guarded');
    const custUlid = newUlid();
    await db('user').insert({ ulid: custUlid, phone_e164: '+254700000092', status: 'active' });
    const custToken = signAccessToken(
      { sub: custUlid, roles: ['customer'], jti: 'j' },
      { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
    );
    const res = await request(app)
      .post(`/api/v1/admin/zones/${zoneUlid}/fee-rules`)
      .set({ Authorization: `Bearer ${custToken}` })
      .send({ baseFeeCents: 10_000, minFeeCents: 10_000 });
    expect(res.status).toBe(403);
  });
});
