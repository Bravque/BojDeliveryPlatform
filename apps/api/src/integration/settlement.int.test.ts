import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuditService } from '../auth/audit-service';
import { newUlid } from '../auth/crypto';
import { createKnexAuthRepo } from '../auth/repo';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createLedgerService } from '../ledger/ledger-service';
import { createKnexLedgerRepo } from '../ledger/repo';
import { merchantPayableCode } from '../ledger/accounts';
import { buildCaptureLines, type OrderMoneySnapshot } from '../payments/capture';
import { buildRefundLines } from '../payments/refund';
import { createRequireAuth } from '../middleware/auth';
import { createKnexSettlementsRepo } from '../settlements/repo';
import { createSettlementService } from '../settlements/settlement-service';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Settlement generation against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

describe.skipIf(!DATABASE_URL)('settlement integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let townId: number;
  let zoneId: number;
  let merchantId: number;
  let customerId: number;
  let addressId: number;
  let financeUlid: string;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      settlements: {
        settlementService: createSettlementService({
          withTransaction: (work) => db.transaction((trx) => work(createKnexSettlementsRepo(trx))),
          auditService: createAuditService(createKnexAuthRepo(db)),
        }),
        requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
      },
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of [
      'settlement_line',
      'settlement',
      'ledger_entry',
      'ledger_transaction',
      'ledger_account',
      'refund',
      'payment',
      'delivery',
      'order',
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
          name: 'CBD',
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
    customerId = Number(
      (
        await db('user').insert({ ulid: newUlid(), phone_e164: '+254700000230', status: 'active' })
      )[0],
    );
    financeUlid = newUlid();
    await db('user').insert({ ulid: financeUlid, phone_e164: '+254700000231', status: 'active' });
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
  });

  /** Seed a delivered order + its delivery + the capture ledger posting; optionally a partial refund. */
  async function deliveredOrder(
    snap: Omit<OrderMoneySnapshot, 'id' | 'ulid' | 'merchantId'>,
    opts: { partialRefundCents?: number } = {},
  ): Promise<void> {
    const ledger = createLedgerService();
    const ledgerRepo = createKnexLedgerRepo(db);
    const orderUlid = newUlid();
    const paymentStatus = opts.partialRefundCents ? 'partially_refunded' : 'paid';
    const [orderId] = await db('order').insert({
      ulid: orderUlid,
      order_number: `BOJ-${orderUlid.slice(-6)}`,
      customer_id: customerId,
      merchant_id: merchantId,
      town_id: townId,
      zone_id: zoneId,
      delivery_address_id: addressId,
      status: 'delivered',
      payment_status: paymentStatus,
      subtotal_cents: snap.subtotalCents,
      delivery_fee_cents: snap.deliveryFeeCents,
      service_fee_cents: snap.serviceFeeCents,
      discount_cents: snap.discountCents,
      total_cents: snap.totalCents,
      commission_bps: 1_000,
      commission_cents: snap.commissionCents,
    });
    await db('delivery').insert({
      order_id: orderId,
      status: 'delivered',
      rider_fee_cents: 7_000,
      delivered_at: db.raw("'2026-10-03 12:00:00.000'"),
    });
    const snapshot: OrderMoneySnapshot = {
      id: Number(orderId),
      ulid: orderUlid,
      merchantId,
      ...snap,
    };
    await ledger.post(ledgerRepo, {
      kind: 'order_capture',
      refType: 'payment',
      refId: Number(orderId),
      idempotencyKey: `order_capture:${orderId}`,
      lines: buildCaptureLines(snapshot),
    });
    if (opts.partialRefundCents) {
      const [paymentId] = await db('payment').insert({
        ulid: newUlid(),
        order_id: orderId,
        method: 'simulated',
        amount_cents: snap.totalCents,
        status: 'succeeded',
        idempotency_key: `pay-${orderUlid}`,
      });
      const [refundId] = await db('refund').insert({
        ulid: newUlid(),
        order_id: orderId,
        payment_id: Number(paymentId),
        amount_cents: opts.partialRefundCents,
        reason: 'partial',
        status: 'completed',
        source: 'manual',
        idempotency_key: `r-${orderUlid}`,
      });
      await ledger.post(ledgerRepo, {
        kind: 'order_refund',
        refType: 'refund',
        refId: Number(refundId),
        idempotencyKey: `order_refund:${refundId}`,
        lines: buildRefundLines(snapshot, opts.partialRefundCents, false),
      });
    }
  }

  const financeAuth = () => ({
    Authorization: `Bearer ${signAccessToken({ sub: financeUlid, roles: ['finance'], jti: 'j' }, { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE })}`,
  });

  it('settlement net = gross − commission − refunds and reconciles with the merchant_payable ledger', async () => {
    // Order 1: subtotal 30000, commission 3000 → payable 27000.
    await deliveredOrder({
      subtotalCents: 30_000,
      deliveryFeeCents: 10_000,
      serviceFeeCents: 0,
      discountCents: 0,
      totalCents: 40_000,
      commissionCents: 3_000,
    });
    // Order 2: subtotal 20000, commission 2000, partial refund 5000 → payable 18000 − 5000 = 13000.
    await deliveredOrder(
      {
        subtotalCents: 20_000,
        deliveryFeeCents: 10_000,
        serviceFeeCents: 0,
        discountCents: 0,
        totalCents: 30_000,
        commissionCents: 2_000,
      },
      { partialRefundCents: 5_000 },
    );

    const res = await request(app)
      .post('/api/v1/admin/settlements/generate')
      .set(financeAuth())
      .send({ periodStart: '2026-10-01', periodEnd: '2026-10-07' });
    expect(res.status).toBe(201);
    expect(res.body.generated).toBe(1);

    const s = res.body.settlements[0];
    expect(s).toMatchObject({
      grossCents: 50_000,
      commissionCents: 5_000,
      refundsCents: 5_000,
      netCents: 40_000,
    });

    // Reconcile with the ledger: merchant_payable balance (credit − debit) equals the settlement net.
    const balances = await createKnexLedgerRepo(db).getAccountBalances();
    const payable = balances.find((b) => b.code === merchantPayableCode(merchantId))!;
    expect(payable.creditCents - payable.debitCents).toBe(40_000);

    // Idempotent: re-generating the same period creates nothing new.
    const again = await request(app)
      .post('/api/v1/admin/settlements/generate')
      .set(financeAuth())
      .send({ periodStart: '2026-10-01', periodEnd: '2026-10-07' });
    expect(again.body.generated).toBe(0);
    expect(again.body.skipped).toBe(1);
    expect(await db('settlement')).toHaveLength(1);
  });

  it('approve moves a draft settlement to approved', async () => {
    await deliveredOrder({
      subtotalCents: 10_000,
      deliveryFeeCents: 10_000,
      serviceFeeCents: 0,
      discountCents: 0,
      totalCents: 20_000,
      commissionCents: 1_000,
    });
    const gen = await request(app)
      .post('/api/v1/admin/settlements/generate')
      .set(financeAuth())
      .send({ periodStart: '2026-10-01', periodEnd: '2026-10-07' });
    const ulid = gen.body.settlements[0].ulid;
    const approved = await request(app)
      .post(`/api/v1/admin/settlements/${ulid}/approve`)
      .set(financeAuth());
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
  });
});
