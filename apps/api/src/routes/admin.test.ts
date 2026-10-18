import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AuditService } from '../auth/audit-service';
import type { OtpService } from '../auth/otp-service';
import type { PasswordService } from '../auth/password-service';
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

function tokenFor(roles: string[]): string {
  return signAccessToken(
    { sub: 'U1', roles, jti: 'jti-1' },
    { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
  );
}

const otpService: OtpService = {
  requestOtp: () => Promise.resolve(),
  verifyOtp: () => Promise.reject(new Error('not used')),
};
const sessionService: SessionService = {
  refresh: () => Promise.reject(new Error('not used')),
  logout: () => Promise.resolve(),
};
const userService: UserService = {
  getProfile: () => Promise.reject(new Error('not used')),
  updateProfile: () => Promise.reject(new Error('not used')),
};
const auditService: AuditService = {
  record: () => Promise.resolve(),
  listRecent: () =>
    Promise.resolve([
      {
        id: 1,
        actorUserId: null,
        actorRole: 'admin',
        action: 'test.event',
        entityType: 'test',
        entityId: null,
        before: null,
        after: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]),
};

const passwordService: PasswordService = {
  login: () => Promise.reject(new Error('not used')),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    auth: {
      otpService,
      passwordService,
      sessionService,
      userService,
      auditService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

describe('GET /api/v1/admin/audit-logs (RBAC)', () => {
  it('returns the audit list for an admin', async () => {
    const res = await request(app())
      .get('/api/v1/admin/audit-logs')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].action).toBe('test.event');
  });

  it('allows ops and finance too', async () => {
    for (const role of ['ops', 'finance']) {
      const res = await request(app())
        .get('/api/v1/admin/audit-logs')
        .set('Authorization', `Bearer ${tokenFor([role])}`);
      expect(res.status).toBe(200);
    }
  });

  it('forbids a customer with 403 (even though the UI would hide it)', async () => {
    const res = await request(app())
      .get('/api/v1/admin/audit-logs')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app()).get('/api/v1/admin/audit-logs');
    expect(res.status).toBe(401);
  });
});
