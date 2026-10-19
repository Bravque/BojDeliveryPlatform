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
 * Reconciliation (Phase 4 increment 4) end-to-end against a real MySQL (DATABASE_URL). Self-skips
 * without one. Proves the behaviours the fake-backed unit tests cannot: the `listOpenPayments`
 * `initiated_at` cutoff, the capture/fail sweep through the real capture service + ledger, and the
 * `findImbalancedTransactions` ledger-invariant query behind the report.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

function tokenFor(roles: string[]): string {
  return signAccessToken(
    { sub: newUlid(), roles, jti: 'jti-recon' },
    { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
  );
}

describe.skipIf(!DATABASE_URL)('reconciliation integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let gateway: SimulatedGateway;
  let userId: number;
  let merchantId: number;
  let townId: number;
  let zoneId: number;
  let addressId: number;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    gateway = new SimulatedGateway();
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
        refundService: createRefundService({
          readRepo: createKnexPaymentsRepo(db),
          withTransaction: (work) =>
            db.transaction((trx) =>
              work({ payments: createKnexPaymentsRepo(trx), ledger: createKnexLedgerRepo(trx) }),
            ),
          ledgerService: createLedgerService(),
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
        await db('user').insert({ ulid: newUlid(), phone_e164: '+254700000140', status: 'active' })
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

  /**
   * Seed a `payment_pending` order + a pending payment + reserved stock. `staleSeconds` backdates
   * `initiated_at` so the `reconcileStalePayments` cutoff can be exercised deterministically.
   */
  async function pendingOrder(
    checkoutRequestId: string,
    staleSeconds = 0,
  ): Promise<{ orderUlid: string }> {
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
      initiated_at:
        staleSeconds > 0 ? db.raw('NOW(3) - INTERVAL ? SECOND', [staleSeconds]) : db.raw('NOW(3)'),
    });
    return { orderUlid };
  }

  const reconcile = (body: object, roles = ['ops']) =>
    request(app)
      .post('/api/v1/admin/payments/reconcile')
      .set('Authorization', `Bearer ${tokenFor(roles)}`)
      .send(body);

  it('sweep: captures a stale pending payment the gateway now reports as success', async () => {
    const cri = 'SIM-RECON-OK';
    const { orderUlid } = await pendingOrder(cri, 3_600);
    gateway.setOutcome(cri, 'success', 40_200);

    const res = await reconcile({ olderThanSec: 120 });
    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(1);
    expect(res.body.captured).toBe(1);

    const payment = (await db('payment').where({ checkout_request_id: cri }).first('status')) as {
      status: string;
    };
    expect(payment.status).toBe('succeeded');
    const order = (await db('order')
      .where({ ulid: orderUlid })
      .first('status', 'payment_status')) as { status: string; payment_status: string };
    expect(order.status).toBe('placed');
    expect(order.payment_status).toBe('paid');

    const captures = await db('ledger_transaction').where({ kind: 'order_capture' });
    expect(captures).toHaveLength(1);
    const balances = await createKnexLedgerRepo(db).getAccountBalances();
    const debit = balances.reduce((s, b) => s + b.debitCents, 0);
    const credit = balances.reduce((s, b) => s + b.creditCents, 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(40_200);
  });

  it('sweep: respects the staleness cutoff (a fresh payment is not swept)', async () => {
    const cri = 'SIM-RECON-FRESH';
    const { orderUlid } = await pendingOrder(cri); // initiated_at ≈ now
    gateway.setOutcome(cri, 'success', 40_200);

    const res = await reconcile({ olderThanSec: 120 });
    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(0); // younger than the 120s cutoff

    const payment = (await db('payment').where({ checkout_request_id: cri }).first('status')) as {
      status: string;
    };
    expect(payment.status).toBe('pending'); // untouched
    const order = (await db('order').where({ ulid: orderUlid }).first('status')) as {
      status: string;
    };
    expect(order.status).toBe('payment_pending');
    expect(await db('ledger_transaction')).toHaveLength(0);
  });

  it('sweep: fails a stale payment the gateway declined and releases the stock reservation', async () => {
    const cri = 'SIM-RECON-FAIL';
    const { orderUlid } = await pendingOrder(cri, 3_600);
    gateway.setOutcome(cri, 'failed');

    const res = await reconcile({ olderThanSec: 120 });
    expect(res.status).toBe(200);
    expect(res.body.failed).toBe(1);

    const order = (await db('order')
      .where({ ulid: orderUlid })
      .first('status', 'payment_status')) as { status: string; payment_status: string };
    expect(order.status).toBe('payment_failed');
    expect(order.payment_status).toBe('failed');
    const inv = (await db('inventory').first('reserved')) as { reserved: number };
    expect(Number(inv.reserved)).toBe(0); // released
    expect(await db('ledger_transaction')).toHaveLength(0);
  });

  it('report: flags an amount mismatch and confirms the ledger balances (finance read)', async () => {
    const cri = 'SIM-RECON-MISMATCH';
    await pendingOrder(cri);
    gateway.setOutcome(cri, 'success', 999); // gateway amount ≠ local amount

    const res = await request(app)
      .get('/api/v1/admin/payments/reconciliation-report')
      .set('Authorization', `Bearer ${tokenFor(['finance'])}`);
    expect(res.status).toBe(200);
    expect(res.body.ledgerBalanced).toBe(true);
    expect(res.body.imbalancedTransactionCount).toBe(0);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].classification).toBe('amount_mismatch');
    expect(res.body.items[0].localStatus).toBe('pending');
    expect(res.body.items[0].remoteStatus).toBe('success');
  });

  it('reconcile forbids a customer (403)', async () => {
    const res = await reconcile({}, ['customer']);
    expect(res.status).toBe(403);
  });
});
