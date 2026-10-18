import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AuditService } from '../auth/audit-service';
import type { OtpService } from '../auth/otp-service';
import type { SessionService } from '../auth/session-service';
import { signAccessToken } from '../auth/tokens';
import type { UserService } from '../auth/user-service';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import { createLogger } from '../platform/logger';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

function mintToken(expiresInSec = 900): string {
  return signAccessToken(
    { sub: 'U1', roles: ['customer'], jti: 'jti-1' },
    { privateKey, expiresInSec, issuer: ISSUER, audience: AUDIENCE },
  );
}

const otpService: OtpService = {
  requestOtp: () => Promise.resolve(),
  verifyOtp: () => Promise.reject(new Error('not used')),
};
const sessionService: SessionService = {
  refresh: () => Promise.resolve({ access: 'new-access', refresh: 'new-refresh' }),
  logout: () => Promise.resolve(),
};
const userService: UserService = {
  getProfile: (ulid) =>
    Promise.resolve({
      ulid,
      phoneE164: '+254712345678',
      email: null,
      displayName: null,
      roles: ['customer'],
    }),
  updateProfile: (ulid, patch) =>
    Promise.resolve({
      ulid,
      phoneE164: '+254712345678',
      email: null,
      displayName: patch.displayName ?? null,
      roles: ['customer'],
    }),
};

const auditService: AuditService = {
  record: () => Promise.resolve(),
  listRecent: () => Promise.resolve([]),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    auth: {
      otpService,
      sessionService,
      userService,
      auditService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

describe('GET /api/v1/me (requireAuth)', () => {
  it('returns the profile for a valid access token', async () => {
    const res = await request(app())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${mintToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.ulid).toBe('U1');
    expect(res.body.roles).toEqual(['customer']);
  });

  it('rejects a missing token with 401', async () => {
    const res = await request(app()).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed token with 401', async () => {
    const res = await request(app()).get('/api/v1/me').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('rejects an expired token with 401', async () => {
    const res = await request(app())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${mintToken(-1)}`);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/v1/me', () => {
  it('updates the display name for an authenticated user', async () => {
    const res = await request(app())
      .patch('/api/v1/me')
      .set('Authorization', `Bearer ${mintToken()}`)
      .send({ displayName: 'Jo' });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Jo');
  });
});

describe('POST /api/v1/auth/refresh & logout', () => {
  it('returns rotated tokens', async () => {
    const res = await request(app()).post('/api/v1/auth/refresh').send({ refresh: 'something' });
    expect(res.status).toBe(200);
    expect(res.body.access).toBe('new-access');
    expect(res.body.refresh).toBe('new-refresh');
  });

  it('rejects a refresh with no token (422)', async () => {
    const res = await request(app()).post('/api/v1/auth/refresh').send({});
    expect(res.status).toBe(422);
  });

  it('logout requires auth and returns 204', async () => {
    const authed = await request(app())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${mintToken()}`)
      .send({ refresh: 'something' });
    expect(authed.status).toBe(204);

    const anon = await request(app()).post('/api/v1/auth/logout').send({ refresh: 'something' });
    expect(anon.status).toBe(401);
  });
});
