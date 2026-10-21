import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../app';
import { createLogger } from '../platform/logger';
import type { ReportService } from '../reports/report-service';

/**
 * Phase 8 Inc 1 — HTTP hardening wiring. Uses a trivial `reports` module only so the `/api/v1`
 * router (and therefore the rate limiters) is mounted; the limiters run before `requireAuth`, so
 * unauthenticated hits still exercise them.
 */

const reportService = {
  summary: () => Promise.reject(new Error('not called')),
  ledgerOverview: () => Promise.reject(new Error('not called')),
} as unknown as ReportService;

// A pass-through auth that sets a role-less principal → report routes cleanly 403 (never reach the
// service), so repeated unauthenticated hits exercise the limiters without 500s.
function app(security: AppDeps['security']) {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    reports: {
      reportService,
      requireAuth: (req, _res, next) => {
        (req as unknown as { principal: { ulid: string; roles: string[] } }).principal = {
          ulid: 'U',
          roles: [],
        };
        next();
      },
    },
    security,
  });
}

describe('security headers + CORS', () => {
  it('sets helmet headers and hides x-powered-by', async () => {
    const res = await request(app({})).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('reflects an allow-listed CORS origin and omits a non-allow-listed one', async () => {
    const a = app({ corsAllowedOrigins: ['https://merchant.boj.local'] });
    const ok = await request(a).get('/health').set('Origin', 'https://merchant.boj.local');
    expect(ok.headers['access-control-allow-origin']).toBe('https://merchant.boj.local');

    const denied = await request(a).get('/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a CORS pre-flight OPTIONS with 204', async () => {
    const res = await request(app({ corsAllowedOrigins: ['https://merchant.boj.local'] }))
      .options('/health')
      .set('Origin', 'https://merchant.boj.local');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});

describe('rate limiting', () => {
  it('returns RATE_LIMITED (429) once the global per-IP cap is exceeded', async () => {
    const a = app({ rateLimit: { windowMs: 60_000, limit: 3 } });
    const path = '/api/v1/admin/reports/ledger';
    for (let i = 0; i < 3; i++) {
      expect((await request(a).get(path)).status).not.toBe(429);
    }
    const limited = await request(a).get(path);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('applies a stricter cap on the /auth surface', async () => {
    const a = app({
      rateLimit: { windowMs: 60_000, limit: 100 },
      authRateLimit: { windowMs: 60_000, limit: 2 },
    });
    expect((await request(a).post('/api/v1/auth/otp/request')).status).not.toBe(429);
    expect((await request(a).post('/api/v1/auth/otp/request')).status).not.toBe(429);
    expect((await request(a).post('/api/v1/auth/otp/request')).status).toBe(429);
  });

  it('leaves health unlimited (limiter is scoped to /api/v1)', async () => {
    const a = app({ rateLimit: { windowMs: 60_000, limit: 2 } });
    for (let i = 0; i < 5; i++) {
      expect((await request(a).get('/health')).status).toBe(200);
    }
  });
});
