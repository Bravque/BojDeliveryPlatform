import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newUlid } from '../auth/crypto';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createLedgerService } from '../ledger/ledger-service';
import { createKnexLedgerRepo } from '../ledger/repo';
import { merchantPayableCode } from '../ledger/accounts';
import { createRequireAuth } from '../middleware/auth';
import { createReportService } from '../reports/report-service';
import { createKnexReportsRepo } from '../reports/repo';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Reports against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

describe.skipIf(!DATABASE_URL)('reports integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let townId: number;
  let zoneId: number;
  let merchantId: number;
  let customerId: number;
  let addressId: number;
  let riderId: number;
  let financeUlid: string;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      reports: {
        reportService: createReportService({
          reportsRepo: createKnexReportsRepo(db),
          ledgerReadRepo: createKnexLedgerRepo(db),
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
      'ledger_entry',
      'ledger_transaction',
      'ledger_account',
      'delivery',
      'order',
      'rider_profile',
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
        await db('user').insert({ ulid: newUlid(), phone_e164: '+254700000250', status: 'active' })
      )[0],
    );
    riderId = Number(
      (
        await db('user').insert({ ulid: newUlid(), phone_e164: '+254700000251', status: 'active' })
      )[0],
    );
    await db('rider_profile').insert({
      user_id: riderId,
      vehicle_type: 'motorbike',
      status: 'approved',
    });
    financeUlid = newUlid();
    await db('user').insert({ ulid: financeUlid, phone_e164: '+254700000252', status: 'active' });
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

  const finance = () => ({
    Authorization: `Bearer ${signAccessToken({ sub: financeUlid, roles: ['finance'], jti: 'j' }, { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE })}`,
  });

  async function seedOrder(opts: {
    status: string;
    paymentStatus: string;
    totalCents: number;
    createdAt: string;
    delivered?: { feeCents: number; at: string };
  }): Promise<void> {
    const orderUlid = newUlid();
    const [orderId] = await db('order').insert({
      ulid: orderUlid,
      order_number: `BOJ-${orderUlid.slice(-6)}`,
      customer_id: customerId,
      merchant_id: merchantId,
      town_id: townId,
      zone_id: zoneId,
      delivery_address_id: addressId,
      status: opts.status,
      payment_status: opts.paymentStatus,
      subtotal_cents: opts.totalCents,
      delivery_fee_cents: 0,
      service_fee_cents: 0,
      discount_cents: 0,
      total_cents: opts.totalCents,
      commission_bps: 1_000,
      commission_cents: Math.round(opts.totalCents * 0.1),
      created_at: db.raw('?', [opts.createdAt]),
    });
    if (opts.delivered) {
      await db('delivery').insert({
        order_id: orderId,
        rider_id: riderId,
        status: 'delivered',
        rider_fee_cents: opts.delivered.feeCents,
        delivered_at: db.raw('?', [opts.delivered.at]),
      });
    }
  }

  it('summary: GMV, volumes, cancel/refund rates, rider utilization over the period', async () => {
    await seedOrder({
      status: 'delivered',
      paymentStatus: 'paid',
      totalCents: 200_000,
      createdAt: '2026-10-03 10:00:00.000',
      delivered: { feeCents: 7_000, at: '2026-10-03 12:00:00.000' },
    });
    await seedOrder({
      status: 'delivered',
      paymentStatus: 'partially_refunded',
      totalCents: 200_000,
      createdAt: '2026-10-04 10:00:00.000',
      delivered: { feeCents: 7_000, at: '2026-10-04 12:00:00.000' },
    });
    await seedOrder({
      status: 'cancelled',
      paymentStatus: 'failed',
      totalCents: 50_000,
      createdAt: '2026-10-02 10:00:00.000',
    });
    await seedOrder({
      status: 'rejected',
      paymentStatus: 'failed',
      totalCents: 60_000,
      createdAt: '2026-10-02 11:00:00.000',
    });
    await seedOrder({
      status: 'refunded',
      paymentStatus: 'refunded',
      totalCents: 30_000,
      createdAt: '2026-10-05 10:00:00.000',
    });
    // An order outside the period must be excluded.
    await seedOrder({
      status: 'delivered',
      paymentStatus: 'paid',
      totalCents: 999_000,
      createdAt: '2026-09-30 10:00:00.000',
    });

    const res = await request(app)
      .get('/api/v1/admin/reports/summary?periodStart=2026-10-01&periodEnd=2026-10-07')
      .set(finance());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      gmvCents: 400_000,
      orderCount: 5,
      deliveredCount: 2,
      cancelledCount: 2,
      refundedCount: 2,
      cancelRate: 0.4,
      refundRate: 0.4,
    });
    expect(res.body.rider).toEqual({ activeRiders: 1, deliveries: 2, feesCents: 14_000 });
  });

  it('ledger overview: natural per-account balances + balanced invariant', async () => {
    const ledger = createLedgerService();
    await ledger.post(createKnexLedgerRepo(db), {
      kind: 'order_capture',
      refType: 'payment',
      refId: 1,
      idempotencyKey: 'seed-capture',
      lines: [
        {
          accountCode: 'mpesa_clearing',
          accountType: 'asset',
          direction: 'debit',
          amountCents: 180_000,
        },
        {
          accountCode: merchantPayableCode(merchantId),
          accountType: 'liability',
          ownerType: 'merchant',
          ownerId: merchantId,
          direction: 'credit',
          amountCents: 180_000,
        },
      ],
    });

    const res = await request(app).get('/api/v1/admin/reports/ledger').set(finance());
    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(true);
    expect(res.body.imbalancedTransactionCount).toBe(0);
    const byCode = Object.fromEntries(
      (res.body.accounts as Array<{ code: string; balanceCents: number }>).map((a) => [
        a.code,
        a.balanceCents,
      ]),
    );
    expect(byCode['mpesa_clearing']).toBe(180_000);
    expect(byCode[merchantPayableCode(merchantId)]).toBe(180_000);
  });
});
