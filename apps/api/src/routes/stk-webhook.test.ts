import express from 'express';
import pinoHttp from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../middleware/error';
import { createLogger } from '../platform/logger';
import type { CaptureService } from '../payments/capture-service';
import type { CaptureOutcome, StkCallback } from '../payments/capture';
import { stkWebhookRouter } from './payments';

/**
 * Phase 8 Inc 2 — STK webhook hardening: optional source-IP allow-list + the shared token, and
 * acceptance of the raw Daraja nested callback shape (mapped) alongside the normalised shape.
 */

function harness(opts: { token?: string; allowlist?: string[] }) {
  const calls: StkCallback[] = [];
  const captureService = {
    processStkResult: (cb: StkCallback): Promise<CaptureOutcome> => {
      calls.push(cb);
      return Promise.resolve('captured');
    },
    simulate: () => Promise.resolve('captured' as CaptureOutcome),
  } as unknown as CaptureService;

  const app = express();
  app.use(pinoHttp({ logger: createLogger({ level: 'silent' }) }));
  app.use(express.json());
  app.use(stkWebhookRouter(captureService, opts.token, opts.allowlist));
  app.use(errorHandler);
  return { app, calls };
}

const TOKEN = 'webhook-secret';

const darajaSuccess = {
  Body: {
    stkCallback: {
      MerchantRequestID: 'mr-1',
      CheckoutRequestID: 'ws_CO_777',
      ResultCode: 0,
      ResultDesc: 'ok',
      CallbackMetadata: {
        Item: [
          { Name: 'Amount', Value: 1500 },
          { Name: 'MpesaReceiptNumber', Value: 'RCPT777' },
        ],
      },
    },
  },
};

describe('STK webhook hardening', () => {
  it('rejects a source IP not on the allow-list (403), before the token check', async () => {
    const { app, calls } = harness({ token: TOKEN, allowlist: ['203.0.113.1'] });
    const res = await request(app)
      .post('/webhooks/mpesa/stk')
      .set('X-Webhook-Token', TOKEN)
      .send(darajaSuccess);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('rejects a missing/invalid token (403)', async () => {
    const { app } = harness({ token: TOKEN });
    expect((await request(app).post('/webhooks/mpesa/stk').send(darajaSuccess)).status).toBe(403);
    expect(
      (
        await request(app)
          .post('/webhooks/mpesa/stk')
          .set('X-Webhook-Token', 'wrong')
          .send(darajaSuccess)
      ).status,
    ).toBe(403);
  });

  it('accepts and maps the Daraja nested callback shape (amount shillings→cents)', async () => {
    const { app, calls } = harness({ token: TOKEN });
    const res = await request(app)
      .post('/webhooks/mpesa/stk')
      .set('X-Webhook-Token', TOKEN)
      .send(darajaSuccess);
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({
      checkoutRequestId: 'ws_CO_777',
      resultCode: 0,
      amountCents: 150_000,
      mpesaReceipt: 'RCPT777',
    });
  });

  it('still accepts the normalised shape (tests/dev), no allow-list = no IP restriction', async () => {
    const { app, calls } = harness({ token: TOKEN });
    const res = await request(app)
      .post('/webhooks/mpesa/stk')
      .set('X-Webhook-Token', TOKEN)
      .send({ checkoutRequestId: 'c1', resultCode: 0, amountCents: 5_000, mpesaReceipt: 'R1' });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ checkoutRequestId: 'c1', amountCents: 5_000 });
  });
});
