import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import type { DeviceService } from '../notifications/device-service';
import { createLogger } from '../platform/logger';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

const token = signAccessToken(
  { sub: 'U1', roles: ['customer'], jti: 'j' },
  { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
);

const deviceService: DeviceService = {
  registerDevice: () => Promise.resolve({ registered: true }),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    notifications: {
      deviceService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

describe('POST /api/v1/devices', () => {
  it('registers a device for an authenticated user (201)', async () => {
    const res = await request(app())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${token}`)
      .send({ pushToken: 'expo-tok-1', platform: 'android' });
    expect(res.status).toBe(201);
    expect(res.body.registered).toBe(true);
  });

  it('rejects an unauthenticated request (401)', async () => {
    const res = await request(app())
      .post('/api/v1/devices')
      .send({ pushToken: 't', platform: 'ios' });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid platform (422)', async () => {
    const res = await request(app())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${token}`)
      .send({ pushToken: 't', platform: 'desktop' });
    expect(res.status).toBe(422);
  });
});
