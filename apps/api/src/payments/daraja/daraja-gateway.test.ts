import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDarajaClient } from './client';
import { DarajaGateway } from './daraja-gateway';

/**
 * Exercises the Daraja STK adapter against a local fake-Daraja HTTP server (no new dependency, no
 * real Safaricom credentials). Proves the request shapes + response mapping so the live swap is a
 * credentials flip.
 */

let server: Server;
let baseUrl: string;
let oauthCalls = 0;
let lastStkBody: Record<string, unknown>;
let lastReversalBody: Record<string, unknown>;
let queryMode: 'success' | 'failed' | 'processing';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.get('/oauth/v1/generate', (req, res) => {
    oauthCalls += 1;
    expect(req.headers.authorization).toMatch(/^Basic /);
    res.json({ access_token: `tok-${oauthCalls}`, expires_in: '3599' });
  });
  app.post('/mpesa/stkpush/v1/processrequest', (req, res) => {
    lastStkBody = req.body as Record<string, unknown>;
    expect(req.headers.authorization).toMatch(/^Bearer /);
    res.json({
      MerchantRequestID: 'mr-9',
      CheckoutRequestID: 'ws_CO_9',
      ResponseCode: '0',
      ResponseDescription: 'Success. Request accepted for processing',
    });
  });
  app.post('/mpesa/stkpushquery/v1/query', (_req, res) => {
    if (queryMode === 'success') {
      res.json({ ResultCode: '0', ResultDesc: 'ok' });
    } else if (queryMode === 'failed') {
      res.json({ ResultCode: '1032', ResultDesc: 'cancelled' });
    } else {
      res.status(500).json({ errorCode: '500.001.1001', errorMessage: 'processing' });
    }
  });
  app.post('/mpesa/reversal/v1/request', (req, res) => {
    lastReversalBody = req.body as Record<string, unknown>;
    res.json({ ConversationID: 'AG_REV_1', ResponseCode: '0', ResponseDescription: 'accepted' });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  queryMode = 'success';
});

function makeGateway() {
  const client = createDarajaClient({ baseUrl, consumerKey: 'ck', consumerSecret: 'cs' });
  return new DarajaGateway({
    client,
    shortcode: '174379',
    passkey: 'passkey-x',
    callbackUrl: 'https://api.boj.local/webhooks/mpesa/stk',
    now: () => new Date('2026-10-21T09:34:56Z'),
  });
}

describe('DarajaGateway — STK push', () => {
  it('builds the STK request (amount→shillings, account ref, password) and maps correlation ids', async () => {
    const res = await makeGateway().initiateStkPush({
      orderNumber: 'BOJ-ABC123',
      amountCents: 150_000,
      phone: '+254700000001',
      idempotencyKey: 'k1',
    });
    expect(res).toEqual({ checkoutRequestId: 'ws_CO_9', merchantRequestId: 'mr-9' });
    expect(lastStkBody.Amount).toBe(1500);
    expect(lastStkBody.AccountReference).toBe('BOJ-ABC123');
    expect(lastStkBody.PartyA).toBe('254700000001');
    expect(lastStkBody.BusinessShortCode).toBe('174379');
    expect(String(lastStkBody.Timestamp)).toMatch(/^\d{14}$/);
    expect(Buffer.from(String(lastStkBody.Password), 'base64').toString()).toMatch(
      /^174379passkey-x\d{14}$/,
    );
  });

  it('rejects a non-whole-shilling amount and a missing phone', async () => {
    await expect(
      makeGateway().initiateStkPush({
        orderNumber: 'BOJ-1',
        amountCents: 150_050,
        phone: '+254700000001',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow(/whole KES shilling/);
    await expect(
      makeGateway().initiateStkPush({
        orderNumber: 'BOJ-1',
        amountCents: 150_000,
        phone: null,
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow(/phone/);
  });

  it('caches the OAuth token across calls (one token fetch for two operations)', async () => {
    const before = oauthCalls;
    const gw = makeGateway();
    await gw.initiateStkPush({
      orderNumber: 'BOJ-1',
      amountCents: 100_000,
      phone: '+254700000002',
      idempotencyKey: 'k',
    });
    await gw.queryStkStatus('ws_CO_9');
    expect(oauthCalls - before).toBe(1);
  });
});

describe('DarajaGateway — STK query', () => {
  it('maps a successful query (amount/receipt null — the query API omits them)', async () => {
    queryMode = 'success';
    expect(await makeGateway().queryStkStatus('ws_CO_9')).toEqual({
      status: 'success',
      resultCode: 0,
      resultDesc: 'ok',
      amountCents: null,
      mpesaReceipt: null,
    });
  });

  it('maps a failed query', async () => {
    queryMode = 'failed';
    const r = await makeGateway().queryStkStatus('ws_CO_9');
    expect(r.status).toBe('failed');
    expect(r.resultCode).toBe(1032);
  });

  it('maps a "still processing" error to pending', async () => {
    queryMode = 'processing';
    expect((await makeGateway().queryStkStatus('ws_CO_9')).status).toBe('pending');
  });
});

describe('DarajaGateway — reversal', () => {
  const reversalCfg = {
    initiatorName: 'apiop',
    securityCredential: 'enc-cred',
    shortcode: '600000',
    resultUrl: 'https://api.boj.local/webhooks/mpesa/reversal-result',
    timeoutUrl: 'https://api.boj.local/webhooks/mpesa/reversal-timeout',
  };

  function makeReversalGateway() {
    const client = createDarajaClient({ baseUrl, consumerKey: 'ck', consumerSecret: 'cs' });
    return new DarajaGateway({
      client,
      shortcode: '174379',
      passkey: 'passkey-x',
      callbackUrl: 'https://api.boj.local/webhooks/mpesa/stk',
      reversal: reversalCfg,
    });
  }

  it('throws when reversal is not configured', async () => {
    await expect(
      makeGateway().initiateReversal({
        originalReceipt: 'R1',
        checkoutRequestId: 'ws_CO_9',
        amountCents: 100_000,
        reference: 'refund-ulid',
      }),
    ).rejects.toThrow(/not configured/);
  });

  it('requires the original receipt (TransactionID)', async () => {
    await expect(
      makeReversalGateway().initiateReversal({
        originalReceipt: null,
        checkoutRequestId: 'ws_CO_9',
        amountCents: 100_000,
        reference: 'refund-ulid',
      }),
    ).rejects.toThrow(/original M-Pesa receipt/);
  });

  it('posts a TransactionReversal and returns the conversation id', async () => {
    const res = await makeReversalGateway().initiateReversal({
      originalReceipt: 'RCPT777',
      checkoutRequestId: 'ws_CO_9',
      amountCents: 100_000,
      reference: 'refund-ulid',
    });
    expect(res).toEqual({ reversalId: 'AG_REV_1' });
    expect(lastReversalBody).toMatchObject({
      CommandID: 'TransactionReversal',
      TransactionID: 'RCPT777',
      Amount: 1000,
      Initiator: 'apiop',
      SecurityCredential: 'enc-cred',
      ReceiverParty: '600000',
    });
  });
});
