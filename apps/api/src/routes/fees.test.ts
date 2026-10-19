import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import type { FeeRuleSummary, FeeService } from '../fees/fee-service';
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

const feeRuleSummary: FeeRuleSummary = {
  ulid: 'F1',
  baseFeeCents: 10_000,
  perKmCents: 2_000,
  minFeeCents: 10_000,
  maxFeeCents: 20_000,
  effectiveFrom: new Date('2026-01-01T00:00:00Z').toISOString(),
  effectiveTo: null,
};

const feeService: FeeService = {
  createRule: () => Promise.resolve(feeRuleSummary),
  updateRule: () => Promise.resolve({ ...feeRuleSummary, perKmCents: 3_000 }),
  listRules: () => Promise.resolve([feeRuleSummary]),
  resolveFee: () => Promise.resolve({ feeCents: 16_000, ruleUlid: 'F1', distanceM: 3_000 }),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    fees: {
      feeService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

const validRule = {
  baseFeeCents: 10_000,
  perKmCents: 2_000,
  minFeeCents: 10_000,
  maxFeeCents: 20_000,
};

describe('admin delivery-fee rules (RBAC = config:write / admin)', () => {
  it('creates a rule under a zone for an admin (201)', async () => {
    const res = await request(app())
      .post('/api/v1/admin/zones/Z1/fee-rules')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send(validRule);
    expect(res.status).toBe(201);
    expect(res.body.ulid).toBe('F1');
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app()).post('/api/v1/admin/zones/Z1/fee-rules').send(validRule);
    expect(res.status).toBe(401);
  });

  it('forbids a non-admin (ops, customer) with 403', async () => {
    for (const role of ['ops', 'customer']) {
      const res = await request(app())
        .post('/api/v1/admin/zones/Z1/fee-rules')
        .set('Authorization', `Bearer ${tokenFor([role])}`)
        .send(validRule);
      expect(res.status).toBe(403);
    }
  });

  it('rejects an invalid body with 422', async () => {
    const res = await request(app())
      .post('/api/v1/admin/zones/Z1/fee-rules')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send({ baseFeeCents: -5, minFeeCents: 10_000 }); // negative base
    expect(res.status).toBe(422);
  });

  it('lists and updates rules for an admin (200)', async () => {
    const list = await request(app())
      .get('/api/v1/admin/zones/Z1/fee-rules')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);

    const patched = await request(app())
      .patch('/api/v1/admin/fee-rules/F1')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send({ perKmCents: 3_000 });
    expect(patched.status).toBe(200);
    expect(patched.body.perKmCents).toBe(3_000);
  });
});
