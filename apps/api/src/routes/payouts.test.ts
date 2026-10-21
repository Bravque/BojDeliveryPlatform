import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import { createLogger } from '../platform/logger';
import type { PayoutService, PayoutView } from '../payouts/payout-service';

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

const view: PayoutView = {
  ulid: 'P1',
  payeeType: 'merchant',
  amountCents: 40_000,
  status: 'draft',
  financeApproved: false,
  opsApproved: false,
  externalRef: null,
};
const payoutService: PayoutService = {
  generatePayouts: () => Promise.resolve({ generated: 1, skipped: 0, payouts: [view] }),
  approveFinance: () => Promise.resolve({ ...view, financeApproved: true }),
  approveOps: () => Promise.resolve({ ...view, opsApproved: true, status: 'approved' }),
  executePayout: () =>
    Promise.resolve({ ...view, status: 'processing', externalRef: 'SIMB2C-REF' }),
  confirmPayout: () => Promise.resolve('paid'),
  applyB2cResult: () => Promise.resolve('paid'),
  simulate: () => Promise.resolve('paid'),
  getPayout: () => Promise.resolve(view),
  listPayouts: () => Promise.resolve([view]),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    payouts: {
      payoutService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
      webhookToken: undefined,
      allowDevSimulate: true,
    },
  });
}

const period = { periodStart: '2026-10-01', periodEnd: '2026-10-07' };

describe('payouts admin (RBAC + dual-sign slots)', () => {
  it('generate: finance 201, customer 403, bad period 422', async () => {
    expect(
      (
        await request(app())
          .post('/api/v1/admin/payouts/generate')
          .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
          .send(period)
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/admin/payouts/generate')
      .set('Authorization', `Bearer ${tokenFor(['finance'])}`)
      .send(period);
    expect(ok.status).toBe(201);
    expect(ok.body.generated).toBe(1);

    const bad = await request(app())
      .post('/api/v1/admin/payouts/generate')
      .set('Authorization', `Bearer ${tokenFor(['finance'])}`)
      .send({ periodStart: 'oct', periodEnd: '2026-10-07' });
    expect(bad.status).toBe(422);
  });

  it('approve-finance: finance 200, ops 403 (payout:approve)', async () => {
    expect(
      (
        await request(app())
          .post('/api/v1/admin/payouts/P1/approve-finance')
          .set('Authorization', `Bearer ${tokenFor(['ops'])}`)
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/admin/payouts/P1/approve-finance')
      .set('Authorization', `Bearer ${tokenFor(['finance'])}`);
    expect(ok.status).toBe(200);
    expect(ok.body.financeApproved).toBe(true);
  });

  it('approve-ops: ops 200, finance 403 (requireRole ops/admin)', async () => {
    expect(
      (
        await request(app())
          .post('/api/v1/admin/payouts/P1/approve-ops')
          .set('Authorization', `Bearer ${tokenFor(['finance'])}`)
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/admin/payouts/P1/approve-ops')
      .set('Authorization', `Bearer ${tokenFor(['ops'])}`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
  });

  it('execute: finance 200 (payout:approve), customer 403', async () => {
    expect(
      (
        await request(app())
          .post('/api/v1/admin/payouts/P1/execute')
          .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/admin/payouts/P1/execute')
      .set('Authorization', `Bearer ${tokenFor(['finance'])}`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('processing');
  });

  it('list/get: allowed for ops (audit:read)', async () => {
    const list = await request(app())
      .get('/api/v1/admin/payouts')
      .set('Authorization', `Bearer ${tokenFor(['ops'])}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);

    const got = await request(app())
      .get('/api/v1/admin/payouts/P1')
      .set('Authorization', `Bearer ${tokenFor(['ops'])}`);
    expect(got.status).toBe(200);
    expect(got.body.amountCents).toBe(40_000);
  });

  it('dev simulate: admin 200, finance 403', async () => {
    expect(
      (
        await request(app())
          .post('/api/v1/dev/payouts/P1/simulate')
          .set('Authorization', `Bearer ${tokenFor(['finance'])}`)
          .send({ outcome: 'success' })
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/dev/payouts/P1/simulate')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send({ outcome: 'success' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('paid');
  });
});
