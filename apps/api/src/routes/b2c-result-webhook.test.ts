import express from 'express';
import pinoHttp from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../middleware/error';
import { createLogger } from '../platform/logger';
import type { PayoutService } from '../payouts/payout-service';
import { b2cResultWebhookRouter } from './payouts';

/** Phase 8 Inc 3 — Daraja B2C result webhook hardening + parsing → applyB2cResult. */

function harness(opts: { token?: string; allowlist?: string[] }) {
  const calls: Array<{ conversationId: string; resultCode: number }> = [];
  const payoutService = {
    applyB2cResult: (input: { conversationId: string; resultCode: number }) => {
      calls.push({ conversationId: input.conversationId, resultCode: input.resultCode });
      return Promise.resolve(input.resultCode === 0 ? 'paid' : 'failed');
    },
  } as unknown as PayoutService;

  const app = express();
  app.use(pinoHttp({ logger: createLogger({ level: 'silent' }) }));
  app.use(express.json());
  app.use(b2cResultWebhookRouter(payoutService, opts.token, opts.allowlist));
  app.use(errorHandler);
  return { app, calls };
}

const TOKEN = 'b2c-secret';

const result = (resultCode: number) => ({
  Result: {
    ResultType: 0,
    ResultCode: resultCode,
    ResultDesc: resultCode === 0 ? 'ok' : 'failed',
    OriginatorConversationID: 'oc-1',
    ConversationID: 'AG_CONV_1',
    TransactionID: 'TX1',
  },
});

describe('B2C result webhook', () => {
  it('rejects a source IP not on the allow-list (403)', async () => {
    const { app, calls } = harness({ token: TOKEN, allowlist: ['203.0.113.9'] });
    const res = await request(app)
      .post('/webhooks/mpesa/b2c-result')
      .set('X-Webhook-Token', TOKEN)
      .send(result(0));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('rejects a missing/invalid token (403)', async () => {
    const { app } = harness({ token: TOKEN });
    expect((await request(app).post('/webhooks/mpesa/b2c-result').send(result(0))).status).toBe(
      403,
    );
  });

  it('parses the Daraja result and confirms the payout', async () => {
    const { app, calls } = harness({ token: TOKEN });
    const res = await request(app)
      .post('/webhooks/mpesa/b2c-result')
      .set('X-Webhook-Token', TOKEN)
      .send(result(0));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
    expect(calls[0]).toEqual({ conversationId: 'AG_CONV_1', resultCode: 0 });
  });

  it('400s an unrecognised body', async () => {
    const { app, calls } = harness({ token: TOKEN });
    const res = await request(app)
      .post('/webhooks/mpesa/b2c-result')
      .set('X-Webhook-Token', TOKEN)
      .send({ not: 'a b2c result' });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
