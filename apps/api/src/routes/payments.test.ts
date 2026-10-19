import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import type { PaymentService, PaymentView } from '../payments/payment-service';
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

const view: PaymentView = {
  ulid: 'PAY1',
  orderUlid: 'ORD1',
  status: 'pending',
  method: 'simulated',
  amountCents: 40_200,
  currency: 'KES',
  checkoutRequestId: 'SIM-1',
};

const paymentService: PaymentService = {
  initiatePayment: () => Promise.resolve(view),
  getPayment: () => Promise.resolve(view),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    payments: {
      paymentService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
    },
  });
}

const auth = () => ({ Authorization: `Bearer ${tokenFor(['customer'])}` });

describe('payments (auth required)', () => {
  it('rejects unauthenticated pay with 401', async () => {
    const res = await request(app())
      .post('/api/v1/orders/ORD1/pay')
      .set('Idempotency-Key', 'k1')
      .send({});
    expect(res.status).toBe(401);
  });

  it('requires an Idempotency-Key header (400)', async () => {
    const res = await request(app()).post('/api/v1/orders/ORD1/pay').set(auth()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('initiates payment (202)', async () => {
    const res = await request(app())
      .post('/api/v1/orders/ORD1/pay')
      .set(auth())
      .set('Idempotency-Key', 'k1')
      .send({ phone: '+254700000001' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(res.body.checkoutRequestId).toBe('SIM-1');
  });

  it('gets a payment (200)', async () => {
    const res = await request(app()).get('/api/v1/payments/PAY1').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.ulid).toBe('PAY1');
  });
});
