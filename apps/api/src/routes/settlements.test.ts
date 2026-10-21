import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import { createLogger } from '../platform/logger';
import type { SettlementService, SettlementView } from '../settlements/settlement-service';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

function tokenFor(roles: string[]): string {
  return signAccessToken(
    { sub: 'U1', roles, jti: 'j' },
    { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
  );
}

const view: SettlementView = {
  ulid: 'S1',
  merchantUlid: 'M1',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-07',
  grossCents: 50_000,
  commissionCents: 5_000,
  refundsCents: 5_000,
  netCents: 40_000,
  status: 'draft',
};
const settlementService: SettlementService = {
  generateSettlements: () => Promise.resolve({ generated: 1, skipped: 0, settlements: [view] }),
  approveSettlement: () => Promise.resolve({ ...view, status: 'approved' }),
  getSettlement: () => Promise.resolve(view),
  listSettlements: () => Promise.resolve([view]),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    settlements: {
      settlementService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

const period = { periodStart: '2026-10-01', periodEnd: '2026-10-07' };

describe('settlements admin (RBAC)', () => {
  it('generate: finance 201, customer 403, bad period 422', async () => {
    expect(
      (
        await request(app())
          .post('/api/v1/admin/settlements/generate')
          .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
          .send(period)
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/admin/settlements/generate')
      .set('Authorization', `Bearer ${tokenFor(['finance'])}`)
      .send(period);
    expect(ok.status).toBe(201);
    expect(ok.body.generated).toBe(1);

    const bad = await request(app())
      .post('/api/v1/admin/settlements/generate')
      .set('Authorization', `Bearer ${tokenFor(['finance'])}`)
      .send({ periodStart: 'oct', periodEnd: '2026-10-07' });
    expect(bad.status).toBe(422);
  });

  it('approve: finance 200, ops 403 (settlement:approve)', async () => {
    expect(
      (
        await request(app())
          .post('/api/v1/admin/settlements/S1/approve')
          .set('Authorization', `Bearer ${tokenFor(['ops'])}`)
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/admin/settlements/S1/approve')
      .set('Authorization', `Bearer ${tokenFor(['finance'])}`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
  });

  it('list/get: allowed for ops (audit:read)', async () => {
    const list = await request(app())
      .get('/api/v1/admin/settlements')
      .set('Authorization', `Bearer ${tokenFor(['ops'])}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);

    const got = await request(app())
      .get('/api/v1/admin/settlements/S1')
      .set('Authorization', `Bearer ${tokenFor(['ops'])}`);
    expect(got.status).toBe(200);
    expect(got.body.netCents).toBe(40_000);
  });
});
