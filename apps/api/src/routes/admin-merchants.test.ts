import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../auth/tokens';
import type { MerchantService, MerchantSummary } from '../merchant/merchant-service';
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

const summary: MerchantSummary = {
  ulid: 'M1',
  name: 'Joe Kitchen',
  categoryType: 'restaurant',
  status: 'pending',
  isOpen: false,
  prepMinutes: 20,
  commissionBps: 1000,
};

const merchantService: MerchantService = {
  createMerchant: () => Promise.resolve(summary),
  approveMerchant: () => Promise.resolve({ ...summary, status: 'approved' }),
  suspendMerchant: () => Promise.resolve({ ...summary, status: 'suspended' }),
  addOwner: () => Promise.resolve(summary),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    merchant: {
      merchantService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

const validBody = {
  townName: 'Migori',
  name: 'Joe Kitchen',
  categoryType: 'restaurant',
  commissionBps: 1000,
};

describe('POST /api/v1/admin/merchants (RBAC)', () => {
  it('creates a merchant for an admin (201)', async () => {
    const res = await request(app())
      .post('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app()).post('/api/v1/admin/merchants').send(validBody);
    expect(res.status).toBe(401);
  });

  it('forbids a customer with 403', async () => {
    const res = await request(app())
      .post('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      .send(validBody);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects an invalid body with 422', async () => {
    const res = await request(app())
      .post('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send({ townName: 'Migori', name: 'X' }); // missing categoryType/commissionBps
    expect(res.status).toBe(422);
  });
});

describe('merchant approve / suspend / owners', () => {
  const adminAuth = () => tokenFor(['admin']);

  it('approves and suspends (200)', async () => {
    const approved = await request(app())
      .post('/api/v1/admin/merchants/M1/approve')
      .set('Authorization', `Bearer ${adminAuth()}`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    const suspended = await request(app())
      .post('/api/v1/admin/merchants/M1/suspend')
      .set('Authorization', `Bearer ${adminAuth()}`)
      .send({ reason: 'policy violation' });
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe('suspended');
  });

  it('requires a reason to suspend (422)', async () => {
    const res = await request(app())
      .post('/api/v1/admin/merchants/M1/suspend')
      .set('Authorization', `Bearer ${adminAuth()}`)
      .send({});
    expect(res.status).toBe(422);
  });

  it('adds an owner (200)', async () => {
    const res = await request(app())
      .post('/api/v1/admin/merchants/M1/owners')
      .set('Authorization', `Bearer ${adminAuth()}`)
      .send({ userUlid: 'OWNER-ULID' });
    expect(res.status).toBe(200);
  });
});
