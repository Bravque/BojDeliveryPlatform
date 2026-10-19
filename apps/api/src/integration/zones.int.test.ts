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
import { createRequireAuth } from '../middleware/auth';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';
import { createKnexZoneRepo } from '../zones/repo';
import { createZoneService } from '../zones/zone-service';

/** Zones & addresses end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

function token(sub: string, roles: string[]): string {
  return signAccessToken(
    { sub, roles, jti: 'j' },
    { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
  );
}

const CBD = { centerLat: -1.0634, centerLng: 34.4731, radiusM: 3000 };

describe.skipIf(!DATABASE_URL)('zones & addresses integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let customerUlid: string;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    const zoneService = createZoneService({
      repo: createKnexZoneRepo(db),
      auditService: createAuditService(createKnexAuthRepo(db)),
    });
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      geo: {
        zoneService,
        addressService: createAddressService({ repo: createKnexAddressRepo(db), zoneService }),
        requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
      },
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of ['audit_log', 'address', 'zone', 'town', 'user_role', 'user']) {
      await db(table).truncate();
    }
    await db.raw('SET FOREIGN_KEY_CHECKS = 1');
    await db('town').insert({ ulid: newUlid(), name: 'Migori', is_active: true });
    customerUlid = newUlid();
    await db('user').insert({ ulid: customerUlid, phone_e164: '+254700000091', status: 'active' });
  });

  const adminAuth = () => ({ Authorization: `Bearer ${token('ADMIN', ['admin'])}` });
  const custAuth = () => ({ Authorization: `Bearer ${token(customerUlid, ['customer'])}` });

  async function createActiveCbdZone() {
    return request(app)
      .post('/api/v1/admin/zones')
      .set(adminAuth())
      .send({ townName: 'Migori', name: 'Migori CBD', ...CBD, isActive: true });
  }

  it('admin creates a zone and lists it with its town ulid', async () => {
    const created = await createActiveCbdZone();
    expect(created.status).toBe(201);
    expect(created.body.isActive).toBe(true);

    const row = (await db('zone').where({ ulid: created.body.ulid }).first()) as {
      radius_m: number;
      is_active: number;
    };
    expect(Number(row.radius_m)).toBe(3000);

    const list = await request(app).get('/api/v1/admin/zones').set(adminAuth());
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].townName).toBe('Migori');
    expect(typeof list.body.items[0].townUlid).toBe('string');
  });

  it('forbids a non-admin from creating a zone (403)', async () => {
    const res = await request(app)
      .post('/api/v1/admin/zones')
      .set(custAuth())
      .send({ townName: 'Migori', name: 'X', ...CBD });
    expect(res.status).toBe(403);
  });

  it('resolves an in-zone address to the serviceable zone', async () => {
    await createActiveCbdZone();
    const res = await request(app)
      .post('/api/v1/addresses')
      .set(custAuth())
      .send({ label: 'Home', line1: 'Market Rd', lat: CBD.centerLat, lng: CBD.centerLng });
    expect(res.status).toBe(201);
    expect(res.body.serviceable).toBe(true);
    expect(res.body.zone.name).toBe('Migori CBD');

    const row = (await db('address').where({ ulid: res.body.ulid }).first()) as {
      zone_id: number | null;
    };
    expect(row.zone_id).not.toBeNull();
  });

  it('marks an out-of-zone address unserviceable (zone_id NULL)', async () => {
    await createActiveCbdZone();
    const res = await request(app)
      .post('/api/v1/addresses')
      .set(custAuth())
      .send({ line1: 'Nairobi CBD', lat: -1.2921, lng: 36.8219 }); // ~250 km away
    expect(res.status).toBe(201);
    expect(res.body.serviceable).toBe(false);
    expect(res.body.zone).toBeNull();

    const row = (await db('address').where({ ulid: res.body.ulid }).first()) as {
      zone_id: number | null;
    };
    expect(row.zone_id).toBeNull();
  });

  it('does not resolve to an inactive zone', async () => {
    // Create the zone inactive, then save an in-zone point — it must be unserviceable.
    await request(app)
      .post('/api/v1/admin/zones')
      .set(adminAuth())
      .send({ townName: 'Migori', name: 'Draft CBD', ...CBD, isActive: false });
    const res = await request(app)
      .post('/api/v1/addresses')
      .set(custAuth())
      .send({ line1: 'Market Rd', lat: CBD.centerLat, lng: CBD.centerLng });
    expect(res.status).toBe(201);
    expect(res.body.serviceable).toBe(false);
  });
});
