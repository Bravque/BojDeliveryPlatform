import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { OtpService } from '../auth/otp-service';
import type { SessionService } from '../auth/session-service';
import type { UserService } from '../auth/user-service';
import { createApp } from '../app';
import { unauthorized } from '../http/errors';
import { createLogger } from '../platform/logger';
import type { AuthModule } from './auth';

const happyOtp: OtpService = {
  requestOtp: () => Promise.resolve(),
  verifyOtp: () =>
    Promise.resolve({
      access: 'access-jwt',
      refresh: 'refresh-tok',
      user: { ulid: 'U1', phoneE164: '+254712345678', roles: ['customer'], displayName: null },
    }),
};

const stubSession: SessionService = {
  refresh: () => Promise.reject(new Error('not used')),
  logout: () => Promise.resolve(),
};

const stubUser: UserService = {
  getProfile: () => Promise.reject(new Error('not used')),
  updateProfile: () => Promise.reject(new Error('not used')),
};

function appWith(overrides: Partial<AuthModule> = {}) {
  const auth: AuthModule = {
    otpService: happyOtp,
    sessionService: stubSession,
    userService: stubUser,
    requireAuth: (_req, _res, next) => next(),
    ...overrides,
  };
  return createApp({ logger: createLogger({ level: 'silent' }), version: 'test', auth });
}

describe('POST /api/v1/auth/otp/request', () => {
  it('accepts a valid request with 202', async () => {
    const res = await request(appWith())
      .post('/api/v1/auth/otp/request')
      .send({ phone: '0712345678' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('otp_sent');
  });

  it('rejects a missing phone with a 422 envelope', async () => {
    const res = await request(appWith()).post('/api/v1/auth/otp/request').send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /api/v1/auth/otp/verify', () => {
  it('returns tokens and profile on success', async () => {
    const res = await request(appWith())
      .post('/api/v1/auth/otp/verify')
      .send({ phone: '0712345678', code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.access).toBe('access-jwt');
    expect(res.body.user.roles).toEqual(['customer']);
  });

  it('rejects a missing code with 422', async () => {
    const res = await request(appWith())
      .post('/api/v1/auth/otp/verify')
      .send({ phone: '0712345678' });
    expect(res.status).toBe(422);
  });

  it('maps a service auth failure to a 401 envelope', async () => {
    const failing: OtpService = {
      requestOtp: () => Promise.resolve(),
      verifyOtp: () => Promise.reject(unauthorized('Invalid or expired code')),
    };
    const res = await request(appWith({ otpService: failing }))
      .post('/api/v1/auth/otp/verify')
      .send({ phone: '0712345678', code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
