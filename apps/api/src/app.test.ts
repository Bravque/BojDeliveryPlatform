import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from './app';
import { forbidden } from './http/errors';
import { createLogger } from './platform/logger';

function testApp(checkReadiness?: () => Promise<Record<string, boolean>>) {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    checkReadiness,
  });
}

describe('health endpoints', () => {
  it('GET /health returns a liveness payload', async () => {
    const res = await request(testApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe('test');
    expect(typeof res.body.uptime).toBe('number');
  });

  it('GET /health/ready returns 200 when all checks pass', async () => {
    const res = await request(testApp(async () => ({ db: true }))).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks.db).toBe(true);
  });

  it('GET /health/ready returns 503 when a check fails', async () => {
    const res = await request(testApp(async () => ({ db: false }))).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
  });

  it('echoes a provided X-Request-Id header', async () => {
    const res = await request(testApp()).get('/health').set('X-Request-Id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
  });
});

describe('error handling', () => {
  it('returns a safe 404 envelope for unknown routes', async () => {
    const res = await request(testApp()).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Not Found');
    expect(typeof res.body.error.requestId).toBe('string');
  });

  it('forwards async route failures to a safe 500 without leaking details', async () => {
    const secret = 'SENSITIVE-connect-ECONNREFUSED-10.0.0.5:3306';
    const res = await request(
      testApp(async () => {
        throw new Error(secret);
      }),
    ).get('/health/ready');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Internal Server Error');
    // The thrown detail must never reach the client.
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it('maps an AppError to its status and code', async () => {
    const res = await request(
      testApp(async () => {
        throw forbidden('nope');
      }),
    ).get('/health/ready');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('nope');
  });

  it('maps a ZodError to a 422 with field details', async () => {
    const res = await request(
      testApp(async () => {
        z.object({ age: z.number() }).parse({ age: 'not-a-number' });
        return { ok: true };
      }),
    ).get('/health/ready');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details[0].field).toBe('age');
  });
});
