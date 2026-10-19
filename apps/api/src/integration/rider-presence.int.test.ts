import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newUlid } from '../auth/crypto';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import { createPresenceService } from '../riders/presence-service';
import { createRiderService } from '../riders/rider-service';
import { createKnexRiderRepo } from '../riders/repo';
import { createAuditService } from '../auth/audit-service';
import { createKnexAuthRepo } from '../auth/repo';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Rider presence end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;
const PING_INTERVAL_SEC = 3600; // large so the second (immediate) ping is deterministically throttled

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

describe.skipIf(!DATABASE_URL)('rider presence integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let riderUlid: string;
  let riderUserId: number;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    const repo = createKnexRiderRepo(db);
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      riders: {
        riderService: createRiderService({
          repo,
          auditService: createAuditService(createKnexAuthRepo(db)),
        }),
        presenceService: createPresenceService({ repo, pingMinIntervalSec: PING_INTERVAL_SEC }),
        requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
      },
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of ['rider_profile', 'user_role', 'user']) {
      await db(table).truncate();
    }
    await db.raw('SET FOREIGN_KEY_CHECKS = 1');

    riderUlid = newUlid();
    riderUserId = Number(
      (
        await db('user').insert({ ulid: riderUlid, phone_e164: '+254700000170', status: 'active' })
      )[0],
    );
    await db('rider_profile').insert({
      user_id: riderUserId,
      vehicle_type: 'motorbike',
      status: 'approved',
    });
    const riderRole = (await db('role').where({ code: 'rider' }).first('id')) as {
      id: number | string;
    };
    await db('user_role').insert({ user_id: riderUserId, role_id: riderRole.id });
  });

  const riderAuth = () => ({
    Authorization: `Bearer ${signAccessToken(
      { sub: riderUlid, roles: ['rider'], jti: 'j' },
      { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
    )}`,
  });

  it('online → ping persists coordinates + last_ping_at', async () => {
    expect((await request(app).post('/api/v1/rider/online').set(riderAuth())).status).toBe(200);
    const online = (await db('rider_profile')
      .where({ user_id: riderUserId })
      .first('is_online')) as {
      is_online: number | boolean;
    };
    expect(Boolean(online.is_online)).toBe(true);

    const ping = await request(app)
      .post('/api/v1/rider/ping')
      .set(riderAuth())
      .send({ lat: -1.0634, lng: 34.4731 });
    expect(ping.status).toBe(200);

    const row = (await db('rider_profile')
      .where({ user_id: riderUserId })
      .first('last_lat', 'last_lng', 'last_ping_at')) as {
      last_lat: number | string;
      last_lng: number | string;
      last_ping_at: string | Date | null;
    };
    expect(Number(row.last_lat)).toBeCloseTo(-1.0634, 4);
    expect(Number(row.last_lng)).toBeCloseTo(34.4731, 4);
    expect(row.last_ping_at).not.toBeNull();
  });

  it('throttles an immediate second ping (last_ping_at unchanged)', async () => {
    await request(app).post('/api/v1/rider/ping').set(riderAuth()).send({ lat: 1, lng: 2 });
    const first = (await db('rider_profile')
      .where({ user_id: riderUserId })
      .first('last_ping_at', 'last_lat')) as { last_ping_at: Date; last_lat: number | string };

    const second = await request(app)
      .post('/api/v1/rider/ping')
      .set(riderAuth())
      .send({ lat: 9, lng: 9 });
    expect(second.status).toBe(200);

    const after = (await db('rider_profile')
      .where({ user_id: riderUserId })
      .first('last_ping_at', 'last_lat')) as { last_ping_at: Date; last_lat: number | string };
    // Within the throttle window → no write: timestamp and coordinates are unchanged.
    expect(new Date(after.last_ping_at).getTime()).toBe(new Date(first.last_ping_at).getTime());
    expect(Number(after.last_lat)).toBe(Number(first.last_lat));
  });

  it('forbids presence for a suspended rider (403)', async () => {
    await db('rider_profile').where({ user_id: riderUserId }).update({ status: 'suspended' });
    const res = await request(app).post('/api/v1/rider/online').set(riderAuth());
    expect(res.status).toBe(403);
  });
});
