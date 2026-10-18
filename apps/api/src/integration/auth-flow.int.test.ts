import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuditService } from '../auth/audit-service';
import type { AuthConfig } from '../auth/config';
import { hashPassword, newUlid } from '../auth/crypto';
import { createOtpService } from '../auth/otp-service';
import { createPasswordService } from '../auth/password-service';
import { createKnexAuthRepo, type FullAuthRepo } from '../auth/repo';
import { createSessionService } from '../auth/session-service';
import { MockSmsProvider } from '../auth/sms/mock';
import { createUserService } from '../auth/user-service';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/**
 * End-to-end integration tests against a real MySQL (DATABASE_URL). These are the only tests
 * that exercise the Knex repository and the full request path together; everything else uses
 * fake repos. Self-skips when DATABASE_URL is absent so it is safe to run locally.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

function makeConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    JWT_PRIVATE_KEY: privateKey,
    JWT_PUBLIC_KEY: publicKey,
    JWT_ISSUER: ISSUER,
    JWT_AUDIENCE: AUDIENCE,
    ACCESS_TOKEN_TTL_SEC: 900,
    REFRESH_TOKEN_TTL_DAYS: 30,
    OTP_LENGTH: 6,
    OTP_TTL_SEC: 300,
    OTP_MAX_ATTEMPTS: 5,
    OTP_PEPPER: 'integration-pepper-0123456789',
    OTP_REQUEST_WINDOW_SEC: 3600,
    OTP_MAX_PER_PHONE: 3,
    OTP_MAX_PER_IP: 100,
    PASSWORD_MAX_ATTEMPTS: 3,
    PASSWORD_LOCKOUT_SEC: 900,
    SMS_PROVIDER: 'mock',
    ...overrides,
  };
}

const config = makeConfig();

describe.skipIf(!DATABASE_URL)('auth integration (real MySQL)', () => {
  let db: Knex;
  let repo: FullAuthRepo;
  let sms: MockSmsProvider;
  let app: ReturnType<typeof createApp>;

  function buildApp(): ReturnType<typeof createApp> {
    return createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      auth: {
        otpService: createOtpService({ repo, sms, config }),
        passwordService: createPasswordService({ repo, config }),
        sessionService: createSessionService({ repo, config }),
        userService: createUserService({ repo }),
        auditService: createAuditService(repo),
        requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
      },
    });
  }

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    repo = createKnexAuthRepo(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of [
      'audit_log',
      'refresh_token',
      'auth_credential_otp',
      'user_role',
      'user',
    ]) {
      await db(table).truncate();
    }
    await db.raw('SET FOREIGN_KEY_CHECKS = 1');
    sms = new MockSmsProvider();
    app = buildApp();
  });

  async function requestCode(phone: string): Promise<string> {
    const res = await request(app).post('/api/v1/auth/otp/request').send({ phone });
    expect(res.status).toBe(202);
    const code = sms.sent.at(-1)?.body.match(/(\d{6})/)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    return code as string;
  }

  it('runs the full OTP login → /me → refresh → logout lifecycle on a real DB', async () => {
    const phone = '0712345678';
    const verified = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ phone, code: await requestCode(phone) });
    expect(verified.status).toBe(200);
    expect(verified.body.user.roles).toEqual(['customer']);

    const access = verified.body.access as string;
    const refresh = verified.body.refresh as string;

    const me = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${access}`);
    expect(me.status).toBe(200);
    expect(me.body.ulid).toBe(verified.body.user.ulid);

    const rotated = await request(app).post('/api/v1/auth/refresh').send({ refresh });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh).not.toBe(refresh);

    // Reusing the old (now rotated) refresh token is rejected.
    const reuse = await request(app).post('/api/v1/auth/refresh').send({ refresh });
    expect(reuse.status).toBe(401);

    const loggedOut = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${access}`)
      .send({ refresh: rotated.body.refresh });
    expect(loggedOut.status).toBe(204);

    const afterLogout = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh: rotated.body.refresh });
    expect(afterLogout.status).toBe(401);
  });

  it('throttles OTP requests per phone against the real DB', async () => {
    const phone = '0712345699';
    for (let i = 0; i < config.OTP_MAX_PER_PHONE; i++) {
      const ok = await request(app).post('/api/v1/auth/otp/request').send({ phone });
      expect(ok.status).toBe(202);
    }
    const blocked = await request(app).post('/api/v1/auth/otp/request').send({ phone });
    expect(blocked.status).toBe(429);
  });

  it('logs in a dashboard user with email/password and locks out after repeated failures', async () => {
    const hash = await hashPassword('AdminPass!1');
    const inserted = await db('user').insert({
      ulid: newUlid(),
      phone_e164: '+254700000009',
      email: 'ops@boj.local',
      display_name: 'Ops',
      password_hash: hash,
      status: 'active',
    });
    const userId = inserted[0];
    const role = (await db('role').where({ code: 'admin' }).first('id')) as { id: number };
    await db('user_role').insert({ user_id: userId, role_id: role.id });

    const ok = await request(app)
      .post('/api/v1/auth/password/login')
      .send({ email: 'ops@boj.local', password: 'AdminPass!1' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.roles).toEqual(['admin']);

    for (let i = 0; i < config.PASSWORD_MAX_ATTEMPTS; i++) {
      const bad = await request(app)
        .post('/api/v1/auth/password/login')
        .send({ email: 'ops@boj.local', password: 'wrong' });
      expect(bad.status).toBe(401);
    }
    // Locked now — even the correct password is refused.
    const locked = await request(app)
      .post('/api/v1/auth/password/login')
      .send({ email: 'ops@boj.local', password: 'AdminPass!1' });
    expect(locked.status).toBe(401);
  });

  it('writes and reads audit entries through the Knex repo', async () => {
    await repo.insertAuditLog({
      actorUserId: null,
      actorRole: 'admin',
      action: 'integration.test.event',
      entityType: 'test',
      entityId: null,
      ip: null,
      before: null,
      after: { ok: true },
    });
    const items = await repo.listRecentAuditLogs(10);
    expect(items).toHaveLength(1);
    expect(items[0]?.action).toBe('integration.test.event');
    expect(items[0]?.after).toEqual({ ok: true });
  });
});
