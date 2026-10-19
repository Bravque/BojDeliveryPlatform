import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AddressService, AddressSummary } from '../addresses/address-service';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import { createLogger } from '../platform/logger';
import type { ZoneService, ZoneSummary } from '../zones/zone-service';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

function tokenFor(roles: string[]): string {
  return signAccessToken(
    { sub: 'U1', roles, jti: 'jti-1' },
    { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
  );
}

const zoneSummary: ZoneSummary = {
  ulid: 'Z1',
  name: 'Migori CBD',
  centerLat: -1.0634,
  centerLng: 34.4731,
  radiusM: 3000,
  isActive: false,
};

const zoneService: ZoneService = {
  createZone: () => Promise.resolve(zoneSummary),
  updateZone: () => Promise.resolve({ ...zoneSummary, isActive: true }),
  listZones: () => Promise.resolve([{ ...zoneSummary, townUlid: 'T1', townName: 'Migori' }]),
  resolveZone: () => Promise.resolve(null),
};

const addressSummary: AddressSummary = {
  ulid: 'A1',
  label: null,
  line1: 'Main St',
  lat: -1.06,
  lng: 34.47,
  serviceable: true,
  zone: { ulid: 'Z1', name: 'Migori CBD' },
};

const addressService: AddressService = {
  createAddress: () => Promise.resolve(addressSummary),
  listAddresses: () => Promise.resolve([addressSummary]),
  updateAddress: () => Promise.resolve(addressSummary),
  deleteAddress: () => Promise.resolve(),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    geo: {
      zoneService,
      addressService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

const validZone = {
  townName: 'Migori',
  name: 'Migori CBD',
  centerLat: -1.0634,
  centerLng: 34.4731,
  radiusM: 3000,
};
const validAddress = { line1: 'Main St', lat: -1.06, lng: 34.47 };

describe('admin zones (RBAC = config:write / admin)', () => {
  it('creates a zone for an admin (201)', async () => {
    const res = await request(app())
      .post('/api/v1/admin/zones')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send(validZone);
    expect(res.status).toBe(201);
    expect(res.body.ulid).toBe('Z1');
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app()).post('/api/v1/admin/zones').send(validZone);
    expect(res.status).toBe(401);
  });

  it('forbids a non-admin (ops, customer) with 403', async () => {
    for (const role of ['ops', 'customer']) {
      const res = await request(app())
        .post('/api/v1/admin/zones')
        .set('Authorization', `Bearer ${tokenFor([role])}`)
        .send(validZone);
      expect(res.status).toBe(403);
    }
  });

  it('rejects an invalid body with 422', async () => {
    const res = await request(app())
      .post('/api/v1/admin/zones')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send({ townName: 'Migori', name: 'CBD' }); // missing centre/radius
    expect(res.status).toBe(422);
  });

  it('updates and lists zones for an admin (200)', async () => {
    const patched = await request(app())
      .patch('/api/v1/admin/zones/Z1')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send({ isActive: true });
    expect(patched.status).toBe(200);
    expect(patched.body.isActive).toBe(true);

    const list = await request(app())
      .get('/api/v1/admin/zones')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].townUlid).toBe('T1');
  });
});

describe('customer addresses (auth required, owner-scoped)', () => {
  it('creates an address for an authenticated customer (201)', async () => {
    const res = await request(app())
      .post('/api/v1/addresses')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      .send(validAddress);
    expect(res.status).toBe(201);
    expect(res.body.serviceable).toBe(true);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app()).post('/api/v1/addresses').send(validAddress);
    expect(res.status).toBe(401);
  });

  it('rejects an invalid body with 422', async () => {
    const res = await request(app())
      .post('/api/v1/addresses')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      .send({ lat: -1.06, lng: 34.47 }); // missing line1
    expect(res.status).toBe(422);
  });

  it('lists, updates and deletes addresses (200/200/204)', async () => {
    const list = await request(app())
      .get('/api/v1/addresses')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);

    const patched = await request(app())
      .patch('/api/v1/addresses/A1')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      .send({ label: 'Home' });
    expect(patched.status).toBe(200);

    const deleted = await request(app())
      .delete('/api/v1/addresses/A1')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`);
    expect(deleted.status).toBe(204);
  });
});
