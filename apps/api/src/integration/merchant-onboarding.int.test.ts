import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuditService } from '../auth/audit-service';
import { newUlid } from '../auth/crypto';
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

/** Merchant onboarding end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';
const adminToken = signAccessToken(
  { sub: 'ADMIN-ULID', roles: ['admin'], jti: 'j' },
  { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
);

describe.skipIf(!DATABASE_URL)('merchant onboarding integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    const merchantService = createMerchantService({
      repo: createKnexMerchantRepo(db),
      auditService: createAuditService(createKnexAuthRepo(db)),
    });
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      merchant: {
        merchantService,
        catalogueService: createCatalogueService({ repo: createKnexCatalogueRepo(db) }),
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
    await db('town').insert({ name: 'Migori', is_active: true });
  });

  function auth() {
    return { Authorization: `Bearer ${adminToken}` };
  }

  it('creates a pending merchant, links the owner, grants the role, and audits it', async () => {
    const ownerUlid = newUlid();
    const ownerInsert = await db('user').insert({
      ulid: ownerUlid,
      phone_e164: '+254700000055',
      status: 'active',
    });
    const ownerId = ownerInsert[0];

    const res = await request(app).post('/api/v1/admin/merchants').set(auth()).send({
      townName: 'Migori',
      name: 'Joe Kitchen',
      categoryType: 'restaurant',
      commissionBps: 1000,
      ownerUserUlid: ownerUlid,
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');

    const merchant = (await db('merchant').where({ ulid: res.body.ulid }).first()) as {
      id: number;
      status: string;
      commission_bps: number;
    };
    expect(merchant.status).toBe('pending');
    expect(Number(merchant.commission_bps)).toBe(1000);

    const link = await db('merchant_user')
      .where({ merchant_id: merchant.id, user_id: ownerId })
      .first();
    expect(link).toBeTruthy();

    const ownerRole = await db('user_role')
      .join('role', 'role.id', 'user_role.role_id')
      .where({ 'user_role.user_id': ownerId, 'role.code': 'merchant_owner' })
      .first();
    expect(ownerRole).toBeTruthy();

    const audit = await db('audit_log').where({ action: 'merchant.create' }).first();
    expect(audit).toBeTruthy();
  });

  it('approves a merchant (status → approved)', async () => {
    const created = await request(app)
      .post('/api/v1/admin/merchants')
      .set(auth())
      .send({ townName: 'Migori', name: 'Shop', categoryType: 'grocery', commissionBps: 800 });
    expect(created.status).toBe(201);

    const approved = await request(app)
      .post(`/api/v1/admin/merchants/${created.body.ulid}/approve`)
      .set(auth());
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    const row = (await db('merchant').where({ ulid: created.body.ulid }).first()) as {
      status: string;
    };
    expect(row.status).toBe('approved');
  });

  it('rejects an unknown town with 400', async () => {
    const res = await request(app)
      .post('/api/v1/admin/merchants')
      .set(auth())
      .send({ townName: 'Nairobi', name: 'X', categoryType: 'retail', commissionBps: 500 });
    expect(res.status).toBe(400);
  });
});
