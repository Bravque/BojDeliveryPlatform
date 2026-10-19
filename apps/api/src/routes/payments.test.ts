import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import type { CaptureService } from '../payments/capture-service';
import type { PaymentService, PaymentView } from '../payments/payment-service';
import type { ReconcileService } from '../payments/reconcile-service';
import type { RefundService } from '../payments/refund-service';
import { createLogger } from '../platform/logger';

const WEBHOOK_TOKEN = 'test-webhook-token';

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

const captureService: CaptureService = {
  processStkResult: () => Promise.resolve('captured'),
  simulate: () => Promise.resolve('captured'),
};

const reconcileService: ReconcileService = {
  reconcilePayment: () => Promise.resolve('skipped'),
  reconcileStalePayments: () =>
    Promise.resolve({ scanned: 0, captured: 0, failed: 0, stillPending: 0, other: 0 }),
  reconciliationReport: () =>
    Promise.resolve({
      generatedAt: '2026-10-19T00:00:00.000Z',
      ledgerBalanced: true,
      imbalancedTransactionCount: 0,
      items: [],
    }),
};

const refundView = {
  ulid: 'REF1',
  orderUlid: 'ORD1',
  status: 'requested',
  source: 'manual',
  amountCents: 40_200,
  reason: 'customer dispute',
  providerRef: null,
};
const refundService: RefundService = {
  requestRefund: () => Promise.resolve(refundView),
  approveRefund: () => Promise.resolve({ ...refundView, status: 'processing' }),
  rejectRefund: () => Promise.resolve({ ...refundView, status: 'rejected' }),
  processReversalResult: () => Promise.resolve('completed'),
  simulate: () => Promise.resolve('completed'),
  getRefund: () => Promise.resolve(refundView),
};

function app() {
  return createApp({
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    payments: {
      paymentService,
      captureService,
      reconcileService,
      refundService,
      requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
      webhookToken: WEBHOOK_TOKEN,
      allowDevSimulate: true,
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

const callbackBody = {
  checkoutRequestId: 'SIM-1',
  resultCode: 0,
  resultDesc: 'ok',
  amountCents: 40_200,
  mpesaReceipt: 'RCPT1',
};

describe('STK webhook', () => {
  it('rejects a missing/invalid token with 403', async () => {
    expect(
      (await request(app()).post('/api/v1/webhooks/mpesa/stk').send(callbackBody)).status,
    ).toBe(403);
    const wrong = await request(app())
      .post('/api/v1/webhooks/mpesa/stk')
      .set('X-Webhook-Token', 'nope')
      .send(callbackBody);
    expect(wrong.status).toBe(403);
  });

  it('acks 200 with the outcome for a valid token', async () => {
    const res = await request(app())
      .post('/api/v1/webhooks/mpesa/stk')
      .set('X-Webhook-Token', WEBHOOK_TOKEN)
      .send(callbackBody);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('captured');
  });

  it('rejects a malformed callback body with 422', async () => {
    const res = await request(app())
      .post('/api/v1/webhooks/mpesa/stk')
      .set('X-Webhook-Token', WEBHOOK_TOKEN)
      .send({ resultDesc: 'no checkout id' });
    expect(res.status).toBe(422);
  });
});

describe('dev simulate (admin only)', () => {
  it('forbids a non-admin (403) and allows an admin (200)', async () => {
    const forbiddenRes = await request(app())
      .post('/api/v1/dev/payments/PAY1/simulate')
      .set(auth())
      .send({ outcome: 'success' });
    expect(forbiddenRes.status).toBe(403);

    const ok = await request(app())
      .post('/api/v1/dev/payments/PAY1/simulate')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send({ outcome: 'success' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('captured');
  });
});

describe('admin reconciliation', () => {
  it('reconcile: forbids customer (403), allows ops (200)', async () => {
    expect(
      (await request(app()).post('/api/v1/admin/payments/reconcile').set(auth()).send({})).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/admin/payments/reconcile')
      .set('Authorization', `Bearer ${tokenFor(['ops'])}`)
      .send({});
    expect(ok.status).toBe(200);
    expect(ok.body.scanned).toBe(0);
  });

  it('report: allowed for finance, forbidden for customer', async () => {
    expect(
      (await request(app()).get('/api/v1/admin/payments/reconciliation-report').set(auth())).status,
    ).toBe(403);
    const ok = await request(app())
      .get('/api/v1/admin/payments/reconciliation-report')
      .set('Authorization', `Bearer ${tokenFor(['finance'])}`);
    expect(ok.status).toBe(200);
    expect(ok.body.ledgerBalanced).toBe(true);
  });
});

describe('refunds', () => {
  it('request: requires an Idempotency-Key, forbids customer, allows ops (201)', async () => {
    // Customer is forbidden regardless of key.
    expect(
      (
        await request(app())
          .post('/api/v1/orders/ORD1/refunds')
          .set(auth())
          .set('Idempotency-Key', 'r1')
          .send({ amountCents: 40_200, reason: 'dispute' })
      ).status,
    ).toBe(403);
    // Ops without a key → 400.
    expect(
      (
        await request(app())
          .post('/api/v1/orders/ORD1/refunds')
          .set('Authorization', `Bearer ${tokenFor(['ops'])}`)
          .send({ amountCents: 40_200, reason: 'dispute' })
      ).status,
    ).toBe(400);
    const ok = await request(app())
      .post('/api/v1/orders/ORD1/refunds')
      .set('Authorization', `Bearer ${tokenFor(['ops'])}`)
      .set('Idempotency-Key', 'r1')
      .send({ amountCents: 40_200, reason: 'dispute' });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('requested');
  });

  it('approve: forbids ops (no refund:approve), allows finance (200 → processing)', async () => {
    expect(
      (
        await request(app())
          .post('/api/v1/refunds/REF1/approve')
          .set('Authorization', `Bearer ${tokenFor(['ops'])}`)
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/refunds/REF1/approve')
      .set('Authorization', `Bearer ${tokenFor(['finance'])}`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('processing');
  });

  it('dev-simulate: admin only (200)', async () => {
    expect(
      (
        await request(app())
          .post('/api/v1/dev/refunds/REF1/simulate')
          .set('Authorization', `Bearer ${tokenFor(['finance'])}`)
          .send({ outcome: 'success' })
      ).status,
    ).toBe(403);
    const ok = await request(app())
      .post('/api/v1/dev/refunds/REF1/simulate')
      .set('Authorization', `Bearer ${tokenFor(['admin'])}`)
      .send({ outcome: 'success' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('completed');
  });
});
