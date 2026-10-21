import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuditService } from '../auth/audit-service';
import { newUlid } from '../auth/crypto';
import { createKnexAuthRepo } from '../auth/repo';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { buildRiderEarningsLines } from '../delivery/earnings';
import { createLedgerService } from '../ledger/ledger-service';
import { createKnexLedgerRepo } from '../ledger/repo';
import { merchantPayableCode, riderPayableCode } from '../ledger/accounts';
import { createRequireAuth } from '../middleware/auth';
import { createPayoutService } from '../payouts/payout-service';
import { createKnexPayoutsRepo } from '../payouts/repo';
import { SimulatedPayoutGateway } from '../payouts/gateway';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Payout dual-sign + simulated B2C against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

describe.skipIf(!DATABASE_URL)('payout integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let townId: number;
  let zoneId: number;
  let merchantId: number;
  let customerId: number;
  let addressId: number;
  let riderId: number;
  let financeUlid: string;
  let opsUlid: string;
  let adminUlid: string;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    const ledgerService = createLedgerService();
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      payouts: {
        payoutService: createPayoutService({
          withTransaction: (work) =>
            db.transaction((trx) =>
              work({ payouts: createKnexPayoutsRepo(trx), ledger: createKnexLedgerRepo(trx) }),
            ),
          ledgerService,
          gateway: new SimulatedPayoutGateway(),
          auditService: createAuditService(createKnexAuthRepo(db)),
        }),
        requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
        webhookToken: undefined,
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
      'payout_line',
      'payout',
      'settlement_line',
      'settlement',
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
        await db('user').insert({ ulid: newUlid(), phone_e164: '+254700000240', status: 'active' })
      )[0],
    );
    riderId = Number(
      (
        await db('user').insert({ ulid: newUlid(), phone_e164: '+254700000241', status: 'active' })
      )[0],
    );
    await db('rider_profile').insert({
      user_id: riderId,
      vehicle_type: 'motorbike',
      status: 'approved',
    });
    financeUlid = newUlid();
    await db('user').insert({ ulid: financeUlid, phone_e164: '+254700000242', status: 'active' });
    opsUlid = newUlid();
    await db('user').insert({ ulid: opsUlid, phone_e164: '+254700000243', status: 'active' });
    adminUlid = newUlid();
    await db('user').insert({ ulid: adminUlid, phone_e164: '+254700000244', status: 'active' });
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

  const period = { periodStart: '2026-10-01', periodEnd: '2026-10-07' };
  const auth = (ulid: string, roles: string[]) => ({
    Authorization: `Bearer ${signAccessToken({ sub: ulid, roles, jti: 'j' }, { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE })}`,
  });
  const finance = () => auth(financeUlid, ['finance']);
  const ops = () => auth(opsUlid, ['ops']);
  const admin = () => auth(adminUlid, ['admin']);

  /** Credit the merchant's payable (as capture would) and record an approved settlement for it. */
  async function approvedSettlement(netCents: number): Promise<void> {
    const ledger = createLedgerService();
    const ledgerRepo = createKnexLedgerRepo(db);
    await ledger.post(ledgerRepo, {
      kind: 'order_capture',
      refType: 'payment',
      refId: 1,
      idempotencyKey: 'seed-capture-merchant',
      lines: [
        {
          accountCode: 'mpesa_clearing',
          accountType: 'asset',
          direction: 'debit',
          amountCents: netCents,
        },
        {
          accountCode: merchantPayableCode(merchantId),
          accountType: 'liability',
          ownerType: 'merchant',
          ownerId: merchantId,
          direction: 'credit',
          amountCents: netCents,
        },
      ],
    });
    await db('settlement').insert({
      ulid: newUlid(),
      merchant_id: merchantId,
      period_start: period.periodStart,
      period_end: period.periodEnd,
      gross_cents: netCents + 10_000,
      commission_cents: 10_000,
      refunds_cents: 0,
      net_cents: netCents,
      status: 'approved',
    });
  }

  /** Credit the rider's payable (as delivery accrual would) and a delivered delivery in the period. */
  async function riderEarning(feeCents: number): Promise<void> {
    const ledger = createLedgerService();
    await ledger.post(createKnexLedgerRepo(db), {
      kind: 'rider_earnings',
      refType: 'delivery',
      refId: 1,
      idempotencyKey: 'seed-earn-rider',
      lines: buildRiderEarningsLines(riderId, feeCents),
    });
    const orderUlid = newUlid();
    const [orderId] = await db('order').insert({
      ulid: orderUlid,
      order_number: `BOJ-${orderUlid.slice(-6)}`,
      customer_id: customerId,
      merchant_id: merchantId,
      town_id: townId,
      zone_id: zoneId,
      delivery_address_id: addressId,
      status: 'delivered',
      payment_status: 'paid',
      subtotal_cents: 20_000,
      delivery_fee_cents: 10_000,
      service_fee_cents: 0,
      discount_cents: 0,
      total_cents: 30_000,
      commission_bps: 1_000,
      commission_cents: 2_000,
    });
    await db('delivery').insert({
      order_id: orderId,
      rider_id: riderId,
      status: 'delivered',
      rider_fee_cents: feeCents,
      delivered_at: db.raw("'2026-10-03 12:00:00.000'"),
    });
  }

  async function payoutTxnCount(): Promise<number> {
    const rows = (await db('ledger_transaction')
      .where('kind', 'payout')
      .count({ c: '*' })) as Array<{
      c: number | string;
    }>;
    return Number(rows[0]?.c ?? 0);
  }

  it('merchant payout: dual-sign → execute → simulate paid draws down merchant_payable (idempotent)', async () => {
    await approvedSettlement(40_000);

    const gen = await request(app)
      .post('/api/v1/admin/payouts/generate')
      .set(finance())
      .send(period);
    expect(gen.status).toBe(201);
    const merchant = gen.body.payouts.find(
      (p: { payeeType: string }) => p.payeeType === 'merchant',
    );
    expect(merchant.amountCents).toBe(40_000);
    const ulid = merchant.ulid as string;

    // Execute is blocked until BOTH approvals are in.
    expect(
      (await request(app).post(`/api/v1/admin/payouts/${ulid}/execute`).set(finance())).status,
    ).toBe(409);
    expect(
      (await request(app).post(`/api/v1/admin/payouts/${ulid}/approve-finance`).set(finance())).body
        .status,
    ).toBe('draft');
    expect(
      (await request(app).post(`/api/v1/admin/payouts/${ulid}/approve-ops`).set(ops())).body.status,
    ).toBe('approved');

    const exec = await request(app).post(`/api/v1/admin/payouts/${ulid}/execute`).set(finance());
    expect(exec.status).toBe(200);
    expect(exec.body.status).toBe('processing');

    const sim = await request(app)
      .post(`/api/v1/dev/payouts/${ulid}/simulate`)
      .set(admin())
      .send({ outcome: 'success' });
    expect(sim.status).toBe(200);
    expect(sim.body.status).toBe('paid');

    // Ledger: one balanced payout txn drew the payable down to zero.
    expect(await payoutTxnCount()).toBe(1);
    const balances = await createKnexLedgerRepo(db).getAccountBalances();
    const payable = balances.find((b) => b.code === merchantPayableCode(merchantId))!;
    expect(payable.creditCents - payable.debitCents).toBe(0);

    // Source settlement marked paid.
    const settlement = await db('settlement').where({ merchant_id: merchantId }).first('status');
    expect(settlement.status).toBe('paid');

    // Replay the confirm → recognised as already final, no second posting.
    const replay = await request(app)
      .post(`/api/v1/dev/payouts/${ulid}/simulate`)
      .set(admin())
      .send({ outcome: 'success' });
    expect(replay.body.status).toBe('already_final');
    expect(await payoutTxnCount()).toBe(1);
  });

  it('forbids the same user approving both slots (separation of duties)', async () => {
    await approvedSettlement(25_000);
    const gen = await request(app)
      .post('/api/v1/admin/payouts/generate')
      .set(finance())
      .send(period);
    const ulid = gen.body.payouts[0].ulid as string;
    await request(app).post(`/api/v1/admin/payouts/${ulid}/approve-finance`).set(finance());
    // An admin may use the ops slot, but not when they already hold the finance slot.
    const clash = await request(app)
      .post(`/api/v1/admin/payouts/${ulid}/approve-ops`)
      .set(auth(financeUlid, ['finance', 'ops']));
    expect(clash.status).toBe(403);
  });

  it('rider payout: generated from delivered fees, paid draws down rider_payable', async () => {
    await riderEarning(7_000);

    const gen = await request(app)
      .post('/api/v1/admin/payouts/generate')
      .set(finance())
      .send(period);
    const rider = gen.body.payouts.find((p: { payeeType: string }) => p.payeeType === 'rider');
    expect(rider.amountCents).toBe(7_000);
    const ulid = rider.ulid as string;

    await request(app).post(`/api/v1/admin/payouts/${ulid}/approve-finance`).set(finance());
    await request(app).post(`/api/v1/admin/payouts/${ulid}/approve-ops`).set(ops());
    await request(app).post(`/api/v1/admin/payouts/${ulid}/execute`).set(finance());
    const sim = await request(app)
      .post(`/api/v1/dev/payouts/${ulid}/simulate`)
      .set(admin())
      .send({ outcome: 'success' });
    expect(sim.body.status).toBe('paid');

    const balances = await createKnexLedgerRepo(db).getAccountBalances();
    const payable = balances.find((b) => b.code === riderPayableCode(riderId))!;
    expect(payable.creditCents - payable.debitCents).toBe(0);
  });
});
