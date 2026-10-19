import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import { createLogger } from '../platform/logger';
import type { PresenceService, PresenceView } from '../riders/presence-service';
import type { RiderService, RiderSummary } from '../riders/rider-service';

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

const summary: RiderSummary = {
  userUlid: 'U1',
  status: 'pending',
  vehicleType: 'motorbike',
  isOnline: false,
};
const riderService: RiderService = {
  applyAsRider: () => Promise.resolve(summary),
  approveRider: () => Promise.resolve({ ...summary, status: 'approved' }),
  suspendRider: () => Promise.resolve({ ...summary, status: 'suspended' }),
  getOwnRider: () => Promise.resolve(summary),
};

const presence: PresenceView = {
  userUlid: 'U1',
  status: 'approved',
  isOnline: true,
  lastLat: -1.0634,
  lastLng: 34.4731,
};
const presenceService: PresenceService = {
  goOnline: () => Promise.resolve(presence),
  goOffline: () => Promise.resolve({ ...presence, isOnline: false }),
  ping: () => Promise.resolve(presence),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    riders: {
      riderService,
      presenceService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

describe('rider self-service', () => {
  it('rejects an unauthenticated apply with 401', async () => {
    const res = await request(app()).post('/api/v1/rider/apply').send({ vehicleType: 'motorbike' });
    expect(res.status).toBe(401);
  });

  it('applies for any authenticated user (201)', async () => {
    const res = await request(app())
      .post('/api/v1/rider/apply')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      .send({ vehicleType: 'motorbike' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
  });

  it('rejects an invalid vehicle type with 422', async () => {
    const res = await request(app())
      .post('/api/v1/rider/apply')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      .send({ vehicleType: 'spaceship' });
    expect(res.status).toBe(422);
  });

  it('reads the own profile (200)', async () => {
    const res = await request(app())
      .get('/api/v1/rider/me')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`);
    expect(res.status).toBe(200);
    expect(res.body.vehicleType).toBe('motorbike');
  });
});

describe('rider admin onboarding (RBAC)', () => {
  it('forbids a customer approving (403), allows ops (200)', async () => {
    expect(
      (
        await request(app())
          .post('/api/v1/admin/riders/U1/approve')
          .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/admin/riders/U1/approve')
      .set('Authorization', `Bearer ${tokenFor(['ops'])}`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
  });

  it('suspends with a reason (200), requires the reason (422)', async () => {
    const ok = await request(app())
      .post('/api/v1/admin/riders/U1/suspend')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send({ reason: 'documents expired' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('suspended');

    const bad = await request(app())
      .post('/api/v1/admin/riders/U1/suspend')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send({});
    expect(bad.status).toBe(422);
  });
});

describe('rider presence (RBAC + validation)', () => {
  it('forbids a non-rider going online (403), allows a rider (200)', async () => {
    expect(
      (
        await request(app())
          .post('/api/v1/rider/online')
          .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/rider/online')
      .set('Authorization', `Bearer ${tokenFor(['rider'])}`);
    expect(ok.status).toBe(200);
    expect(ok.body.isOnline).toBe(true);
  });

  it('pings with coordinates (200), rejects an out-of-range lat (422)', async () => {
    const ok = await request(app())
      .post('/api/v1/rider/ping')
      .set('Authorization', `Bearer ${tokenFor(['rider'])}`)
      .send({ lat: -1.0634, lng: 34.4731 });
    expect(ok.status).toBe(200);
    expect(ok.body.lastLat).toBe(-1.0634);

    const bad = await request(app())
      .post('/api/v1/rider/ping')
      .set('Authorization', `Bearer ${tokenFor(['rider'])}`)
      .send({ lat: 999, lng: 0 });
    expect(bad.status).toBe(422);
  });
});
