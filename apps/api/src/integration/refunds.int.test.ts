import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newUlid } from '../auth/crypto';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createLedgerService } from '../ledger/ledger-service';
import { createKnexLedgerRepo } from '../ledger/repo';
import { createRequireAuth } from '../middleware/auth';
import { createCaptureService } from '../payments/capture-service';
import { createPaymentService } from '../payments/payment-service';
import { createReconcileService } from '../payments/reconcile-service';
import { createRefundService } from '../payments/refund-service';
import { createKnexPaymentsRepo } from '../payments/repo';
import { SimulatedGateway } from '../payments/simulated-gateway';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/**
 * Refund lifecycle (Phase 4 increment 5) end-to-end against a real MySQL (DATABASE_URL).
 * Self-skips without one. Drives a captured order through request → approve → provider-confirm
 * and asserts the balanced ledger reversal, separation of duties, the net-refundable cap, and
 * refund-execute idempotency.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

function tokenFor(ulid: string, roles: string[]): string {
  return signAccessToken(
    { sub: ulid, roles, jti: `jti-${ulid}` },
    { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
  );
}

describe.skipIf(!DATABASE_URL)('refunds integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let gateway: SimulatedGateway;
  let townId: number;
  let zoneId: number;
  let merchantId: number;
  let addressId: number;
  let seededCustomerId: number;
  // Distinct principals so separation of duties (requester ≠ approver) can be exercised.
  let opsUlid: string;
  let financeUlid: string;
  let adminUlid: string;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    gateway = new SimulatedGateway();
    const ledgerService = createLedgerService();
    const captureService = createCaptureService({
      readRepo: createKnexPaymentsRepo(db),
      withTransaction: (work) =>
        db.transaction((trx) =>
          work({ payments: createKnexPaymentsRepo(trx), ledger: createKnexLedgerRepo(trx) }),
        ),
      ledgerService,
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
        refundService: createRefundService({
          readRepo: createKnexPaymentsRepo(db),
          withTransaction: (work) =>
            db.transaction((trx) =>
              work({ payments: createKnexPaymentsRepo(trx), ledger: createKnexLedgerRepo(trx) }),
            ),
          ledgerService,
          gateway,
        }),
        requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
        webhookToken: 'int-webhook-token',
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
      'refund',
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
    // Staff principals for the refund workflow.
    opsUlid = newUlid();
    financeUlid = newUlid();
    adminUlid = newUlid();
    for (const [ulid, phone] of [
      [opsUlid, '+254700000150'],
      [financeUlid, '+254700000151'],
      [adminUlid, '+254700000152'],
    ] as const) {
      await db('user').insert({ ulid, phone_e164: phone, status: 'active' });
    }
    const customerUlid = newUlid();
    const customerId = Number(
      (
        await db('user').insert({
          ulid: customerUlid,
          phone_e164: '+254700000153',
          status: 'active',
        })
      )[0],
    );
    addressId = Number(
      (
        await db('address').insert({
          ulid: newUlid(),
          user_id: customerId,
          line1: 'Market Rd',
          lat: -1.0634,
          lng: 34.4731,
        })
      )[0],
    );
    seededCustomerId = customerId;
  });

  /** Seed a captured (placed + paid) order with a succeeded payment. Returns the order ulid. */
  async function capturedOrder(): Promise<{ orderUlid: string }> {
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
      order_number: `BOJ-${orderUlid.slice(-6)}`,
      customer_id: seededCustomerId,
      merchant_id: merchantId,
      town_id: townId,
      zone_id: zoneId,
      delivery_address_id: addressId,
      status: 'placed',
      payment_status: 'paid',
      subtotal_cents: 30_200,
      delivery_fee_cents: 10_000,
      service_fee_cents: 0,
      discount_cents: 0,
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
      status: 'succeeded',
      checkout_request_id: `SIM-${orderUlid.slice(-6)}`,
      mpesa_receipt: `RCPT${orderUlid.slice(-6)}`,
      idempotency_key: `pk-${orderUlid}`,
    });
    return { orderUlid };
  }

  const opsAuth = () => ({ Authorization: `Bearer ${tokenFor(opsUlid, ['ops'])}` });
  const financeAuth = () => ({ Authorization: `Bearer ${tokenFor(financeUlid, ['finance'])}` });
  const adminAuth = () => ({ Authorization: `Bearer ${tokenFor(adminUlid, ['admin'])}` });

  async function ledgerNet(): Promise<number> {
    const balances = await createKnexLedgerRepo(db).getAccountBalances();
    return balances.reduce((s, b) => s + b.debitCents - b.creditCents, 0);
  }

  it('full lifecycle: request → approve → confirm posts a balanced reversal and refunds the order', async () => {
    const { orderUlid } = await capturedOrder();

    const requested = await request(app)
      .post(`/api/v1/orders/${orderUlid}/refunds`)
      .set(opsAuth())
      .set('Idempotency-Key', 'ref-1')
      .send({ amountCents: 40_200, reason: 'customer dispute' });
    expect(requested.status).toBe(201);
    expect(requested.body.status).toBe('requested');
    const refundUlid = requested.body.ulid;

    const approved = await request(app)
      .post(`/api/v1/refunds/${refundUlid}/approve`)
      .set(financeAuth());
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('processing');

    const confirmed = await request(app)
      .post(`/api/v1/dev/refunds/${refundUlid}/simulate`)
      .set(adminAuth())
      .send({ outcome: 'success' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('completed');

    const refund = (await db('refund').where({ ulid: refundUlid }).first('status')) as {
      status: string;
    };
    expect(refund.status).toBe('completed');
    const order = (await db('order').where({ ulid: orderUlid }).first('payment_status')) as {
      payment_status: string;
    };
    expect(order.payment_status).toBe('refunded');
    // The full order→refund cycle leaves the ledger balanced (capture + reversal).
    expect(await ledgerNet()).toBe(0);
    expect(await db('ledger_transaction').where({ kind: 'order_refund' })).toHaveLength(1);
  });

  it('separation of duties: the requester cannot approve their own refund (403)', async () => {
    const { orderUlid } = await capturedOrder();
    const requested = await request(app)
      .post(`/api/v1/orders/${orderUlid}/refunds`)
      .set(opsAuth())
      .set('Idempotency-Key', 'ref-1')
      .send({ amountCents: 1_000, reason: 'x' });
    expect(requested.status).toBe(201);

    // Approve as the SAME ops principal who requested it → forbidden.
    const selfApprove = await request(app)
      .post(`/api/v1/refunds/${requested.body.ulid}/approve`)
      .set({ Authorization: `Bearer ${tokenFor(opsUlid, ['ops', 'finance'])}` });
    expect(selfApprove.status).toBe(403);
  });

  it('rejects a refund above the net refundable total (400)', async () => {
    const { orderUlid } = await capturedOrder();
    const res = await request(app)
      .post(`/api/v1/orders/${orderUlid}/refunds`)
      .set(opsAuth())
      .set('Idempotency-Key', 'ref-1')
      .send({ amountCents: 99_999, reason: 'too much' });
    expect(res.status).toBe(400);
  });

  it('refund execute is idempotent: confirming twice never double-posts', async () => {
    const { orderUlid } = await capturedOrder();
    const requested = await request(app)
      .post(`/api/v1/orders/${orderUlid}/refunds`)
      .set(opsAuth())
      .set('Idempotency-Key', 'ref-1')
      .send({ amountCents: 5_000, reason: 'partial' });
    const refundUlid = requested.body.ulid;
    await request(app).post(`/api/v1/refunds/${refundUlid}/approve`).set(financeAuth());

    const first = await request(app)
      .post(`/api/v1/dev/refunds/${refundUlid}/simulate`)
      .set(adminAuth())
      .send({ outcome: 'success' });
    expect(first.body.status).toBe('completed');
    const second = await request(app)
      .post(`/api/v1/dev/refunds/${refundUlid}/simulate`)
      .set(adminAuth())
      .send({ outcome: 'success' });
    expect(second.body.status).toBe('already_final');

    expect(await db('ledger_transaction').where({ kind: 'order_refund' })).toHaveLength(1);
    const order = (await db('order').where({ ulid: orderUlid }).first('payment_status')) as {
      payment_status: string;
    };
    expect(order.payment_status).toBe('partially_refunded');
  });
});
