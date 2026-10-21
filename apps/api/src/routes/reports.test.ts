import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import { createLogger } from '../platform/logger';
import type { ReportService } from '../reports/report-service';

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

const reportService: ReportService = {
  summary: () =>
    Promise.resolve({
      periodStart: '2026-10-01',
      periodEnd: '2026-10-07',
      gmvCents: 400_000,
      orderCount: 10,
      deliveredCount: 8,
      cancelledCount: 2,
      refundedCount: 1,
      cancelRate: 0.2,
      refundRate: 0.1,
      byStatus: [{ status: 'delivered', count: 8, totalCents: 400_000 }],
      rider: { activeRiders: 3, deliveries: 8, feesCents: 56_000 },
    }),
  ledgerOverview: () =>
    Promise.resolve({
      generatedAt: new Date().toISOString(),
      balanced: true,
      imbalancedTransactionCount: 0,
      accounts: [],
    }),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    reports: {
      reportService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

const q = '?periodStart=2026-10-01&periodEnd=2026-10-07';

describe('reports admin (RBAC, read-only)', () => {
  it('summary: finance/ops/admin 200, customer 403, bad period 422', async () => {
    for (const role of ['finance', 'ops', 'admin']) {
      const ok = await request(app())
        .get(`/api/v1/admin/reports/summary${q}`)
        .set('Authorization', `Bearer ${tokenFor([role])}`);
      expect(ok.status).toBe(200);
      expect(ok.body.gmvCents).toBe(400_000);
    }
    expect(
      (
        await request(app())
          .get(`/api/v1/admin/reports/summary${q}`)
          .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app())
          .get('/api/v1/admin/reports/summary?periodStart=oct&periodEnd=2026-10-07')
          .set('Authorization', `Bearer ${tokenFor(['finance'])}`)
      ).status,
    ).toBe(422);
  });

  it('ledger overview: ops 200, customer 403', async () => {
    const ok = await request(app())
      .get('/api/v1/admin/reports/ledger')
      .set('Authorization', `Bearer ${tokenFor(['ops'])}`);
    expect(ok.status).toBe(200);
    expect(ok.body.balanced).toBe(true);
    expect(
      (
        await request(app())
          .get('/api/v1/admin/reports/ledger')
          .set('Authorization', `Bearer ${tokenFor(['customer'])}`)
      ).status,
    ).toBe(403);
  });
});
