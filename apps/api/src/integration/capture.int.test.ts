import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newUlid } from '../auth/crypto';
import { createApp } from '../app';
import { createLedgerService } from '../ledger/ledger-service';
import { createKnexLedgerRepo } from '../ledger/repo';
import { createRequireAuth } from '../middleware/auth';
import { createCaptureService } from '../payments/capture-service';
import { createPaymentService } from '../payments/payment-service';
import { createReconcileService } from '../payments/reconcile-service';
import { createKnexPaymentsRepo } from '../payments/repo';
import { SimulatedGateway } from '../payments/simulated-gateway';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** STK capture end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const WEBHOOK_TOKEN = 'int-webhook-token';

describe.skipIf(!DATABASE_URL)('STK capture integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let userId: number;
  let merchantId: number;
  let townId: number;
  let zoneId: number;
  let addressId: number;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    const gateway = new SimulatedGateway();
    const captureService = createCaptureService({
      readRepo: createKnexPaymentsRepo(db),
      withTransaction: (work) =>
        db.transaction((trx) =>
          work({ payments: createKnexPaymentsRepo(trx), ledger: createKnexLedgerRepo(trx) }),
        ),
      ledgerService: createLedgerService(),
    });
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      payments: {
        paymentService: createPaymentService({
          readRepo: createKnexPaymentsRepo(db),
          withTransaction: (work) => db.transaction((trx) => work(createKnexPaymentsRepo(trx))),
          gateway,
          method: 'simulated',
        }),
        captureService,
        reconcileService: createReconcileService({
          readRepo: createKnexPaymentsRepo(db),
          gateway,
          captureService,
          ledgerReadRepo: createKnexLedgerRepo(db),
        }),
        requireAuth: createRequireAuth({ publicKey, issuer: 'boj-api', audience: 'boj-clients' }),
        webhookToken: WEBHOOK_TOKEN,
        allowDevSimulate: true,
      },
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of [
      'ledger_entry',
      'ledger_transaction',
      'ledger_account',
      'payment_event',
      'payment',
      'order_status_history',
      'order_item',
      'order',
      'inventory',
      'product',
      'address',
      'merchant',
      'zone',
      'user',
      'town',
    ]) {
      await db(table).truncate();
    }
    await db.raw('SET FOREIGN_KEY_CHECKS = 1');

    townId = Number(
      (await db('town').insert({ ulid: newUlid(), name: 'Migori', is_active: true }))[0],
    );
    userId = Number(
      (
        await db('user').insert({ ulid: newUlid(), phone_e164: '+254700000130', status: 'active' })
      )[0],
    );
    zoneId = Number(
      (
        await db('zone').insert({
          ulid: newUlid(),
          town_id: townId,
          name: 'Migori CBD',
          center_lat: -1.0634,
          center_lng: 34.4731,
          radius_m: 3000,
          is_active: true,
        })
      )[0],
    );
    merchantId = Number(
      (
        await db('merchant').insert({
          ulid: newUlid(),
          town_id: townId,
          name: 'Joe Kitchen',
          category_type: 'restaurant',
          status: 'approved',
          is_open: true,
          commission_bps: 1_000,
        })
      )[0],
    );
    addressId = Number(
      (
        await db('address').insert({
          ulid: newUlid(),
          user_id: userId,
          line1: 'Market Rd',
          lat: -1.0634,
          lng: 34.4731,
        })
      )[0],
    );
  });

  /** Seed a payment_pending order + a pending payment + reserved stock. */
  async function pendingOrder(checkoutRequestId: string): Promise<{ orderUlid: string }> {
    const [productId] = await db('product').insert({
      ulid: newUlid(),
      merchant_id: merchantId,
      name: 'Ugali',
      price_cents: 15_000,
      is_available: true,
    });
    await db('inventory').insert({
      product_id: productId,
      track_stock: true,
      quantity: 10,
      reserved: 2,
    });
    const orderUlid = newUlid();
    const [orderId] = await db('order').insert({
      ulid: orderUlid,
      order_number: `BOJ-${checkoutRequestId.slice(-6)}`,
      customer_id: userId,
      merchant_id: merchantId,
      town_id: townId,
      zone_id: zoneId,
      delivery_address_id: addressId,
      status: 'payment_pending',
      subtotal_cents: 30_200,
      delivery_fee_cents: 10_000,
      total_cents: 40_200,
      commission_bps: 1_000,
      commission_cents: 3_020,
    });
    await db('order_item').insert({
      order_id: orderId,
      product_id: productId,
      name_snapshot: 'Ugali',
      unit_price_cents: 15_000,
      quantity: 2,
      line_total_cents: 30_200,
    });
    await db('payment').insert({
      ulid: newUlid(),
      order_id: orderId,
      method: 'simulated',
      amount_cents: 40_200,
      status: 'pending',
      checkout_request_id: checkoutRequestId,
      idempotency_key: `idem-${checkoutRequestId}`,
    });
    return { orderUlid };
  }

  const webhook = (body: object) =>
    request(app)
      .post('/api/v1/webhooks/mpesa/stk')
      .set('X-Webhook-Token', WEBHOOK_TOKEN)
      .send(body);

  it('acceptance: replaying the same success callback 100× yields exactly one capture', async () => {
    const cri = 'SIM-REPLAY';
    const { orderUlid } = await pendingOrder(cri);
    const body = {
      checkoutRequestId: cri,
      resultCode: 0,
      resultDesc: 'ok',
      amountCents: 40_200,
      mpesaReceipt: 'RCPTREPLAY',
    };

    const statuses: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const res = await webhook(body);
      expect(res.status).toBe(200);
      statuses.push(res.body.status);
    }
    expect(statuses.filter((s) => s === 'captured')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'duplicate')).toHaveLength(99);

    const captures = await db('ledger_transaction').where({ kind: 'order_capture' });
    expect(captures).toHaveLength(1); // exactly one capture ledger txn
    const payment = (await db('payment').where({ checkout_request_id: cri }).first('status')) as {
      status: string;
    };
    expect(payment.status).toBe('succeeded');
    const order = (await db('order')
      .where({ ulid: orderUlid })
      .first('status', 'payment_status')) as {
      status: string;
      payment_status: string;
    };
    expect(order.status).toBe('placed');
    expect(order.payment_status).toBe('paid');

    // The capture ledger transaction balances.
    const balances = await createKnexLedgerRepo(db).getAccountBalances();
    const debit = balances.reduce((s, b) => s + b.debitCents, 0);
    const credit = balances.reduce((s, b) => s + b.creditCents, 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(40_200);
  });

  it('quarantines an amount-mismatch callback (never auto-captured)', async () => {
    const cri = 'SIM-MISMATCH';
    const { orderUlid } = await pendingOrder(cri);
    const res = await webhook({
      checkoutRequestId: cri,
      resultCode: 0,
      resultDesc: 'ok',
      amountCents: 999, // wrong
      mpesaReceipt: 'RCPTX',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('amount_mismatch');

    expect(await db('ledger_transaction')).toHaveLength(0);
    const order = (await db('order').where({ ulid: orderUlid }).first('status')) as {
      status: string;
    };
    expect(order.status).toBe('payment_pending'); // untouched
  });

  it('fails a declined payment and releases the stock reservation', async () => {
    const cri = 'SIM-FAIL';
    const { orderUlid } = await pendingOrder(cri);
    const res = await webhook({
      checkoutRequestId: cri,
      resultCode: 1032,
      resultDesc: 'cancelled',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');

    const order = (await db('order')
      .where({ ulid: orderUlid })
      .first('status', 'payment_status')) as {
      status: string;
      payment_status: string;
    };
    expect(order.status).toBe('payment_failed');
    expect(order.payment_status).toBe('failed');
    const inv = (await db('inventory').first('reserved')) as { reserved: number };
    expect(Number(inv.reserved)).toBe(0); // released
  });

  it('rejects a webhook without the shared token (403)', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/mpesa/stk')
      .send({ checkoutRequestId: 'x', resultCode: 0, resultDesc: 'ok' });
    expect(res.status).toBe(403);
  });
});
