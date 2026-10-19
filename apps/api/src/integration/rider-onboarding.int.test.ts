import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuditService } from '../auth/audit-service';
import { newUlid } from '../auth/crypto';
import { createKnexAuthRepo } from '../auth/repo';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import { createKnexRiderRepo } from '../riders/repo';
import { createRiderService } from '../riders/rider-service';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Rider onboarding end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

function tokenFor(ulid: string, roles: string[]): string {
  return signAccessToken(
    { sub: ulid, roles, jti: `jti-${ulid}` },
    { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
  );
}

describe.skipIf(!DATABASE_URL)('rider onboarding integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let applicantUlid: string;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      riders: {
        riderService: createRiderService({
          repo: createKnexRiderRepo(db),
          auditService: createAuditService(createKnexAuthRepo(db)),
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
    for (const table of ['audit_log', 'rider_profile', 'user_role', 'user']) {
      await db(table).truncate();
    }
    await db.raw('SET FOREIGN_KEY_CHECKS = 1');
    applicantUlid = newUlid();
    await db('user').insert({ ulid: applicantUlid, phone_e164: '+254700000160', status: 'active' });
  });

  const applicantAuth = () => ({
    Authorization: `Bearer ${tokenFor(applicantUlid, ['customer'])}`,
  });
  const adminAuth = () => ({ Authorization: `Bearer ${tokenFor('ADMIN-ULID', ['admin'])}` });

  it('apply → pending profile; approve → approved + rider role granted + audited', async () => {
    const applied = await request(app)
      .post('/api/v1/rider/apply')
      .set(applicantAuth())
      .send({ vehicleType: 'motorbike' });
    expect(applied.status).toBe(201);
    expect(applied.body.status).toBe('pending');

    const userId = Number(
      ((await db('user').where({ ulid: applicantUlid }).first('id')) as { id: number | string }).id,
    );
    const profile = (await db('rider_profile').where({ user_id: userId }).first()) as {
      status: string;
      vehicle_type: string;
    };
    expect(profile.status).toBe('pending');
    expect(profile.vehicle_type).toBe('motorbike');

    const approved = await request(app)
      .post(`/api/v1/admin/riders/${applicantUlid}/approve`)
      .set(adminAuth());
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    const row = (await db('rider_profile').where({ user_id: userId }).first('status')) as {
      status: string;
    };
    expect(row.status).toBe('approved');

    const riderRole = await db('user_role')
      .join('role', 'role.id', 'user_role.role_id')
      .where({ 'user_role.user_id': userId, 'role.code': 'rider' })
      .first();
    expect(riderRole).toBeTruthy();

    const audit = await db('audit_log').where({ action: 'rider.approve' }).first();
    expect(audit).toBeTruthy();
  });

  it('rejects a duplicate application with 409', async () => {
    await request(app)
      .post('/api/v1/rider/apply')
      .set(applicantAuth())
      .send({ vehicleType: 'car' });
    const dup = await request(app)
      .post('/api/v1/rider/apply')
      .set(applicantAuth())
      .send({ vehicleType: 'bicycle' });
    expect(dup.status).toBe(409);
  });

  it('forbids a non-admin approving (403)', async () => {
    await request(app)
      .post('/api/v1/rider/apply')
      .set(applicantAuth())
      .send({ vehicleType: 'foot' });
    const res = await request(app)
      .post(`/api/v1/admin/riders/${applicantUlid}/approve`)
      .set(applicantAuth());
    expect(res.status).toBe(403);
  });
});
