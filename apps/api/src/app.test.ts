import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
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
