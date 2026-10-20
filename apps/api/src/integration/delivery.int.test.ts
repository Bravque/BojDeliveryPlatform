import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newUlid } from '../auth/crypto';
import { createKnexAuthRepo } from '../auth/repo';
import { createAuditService } from '../auth/audit-service';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createAssignmentService } from '../delivery/assignment-service';
import { createDeliveryService } from '../delivery/delivery-service';
import { createKnexDeliveryRepo } from '../delivery/repo';
import { createLedgerService } from '../ledger/ledger-service';
import { createKnexLedgerRepo } from '../ledger/repo';
import { createRequireAuth } from '../middleware/auth';
import { createKnexOrdersRepo } from '../orders/repo';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Delivery execution + PIN + rider earnings against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;
const CBD = { lat: -1.0634, lng: 34.4731 };

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

function token(ulid: string, roles: string[]): string {
  return signAccessToken(
    { sub: ulid, roles, jti: 'j' },
    { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
  );
}

describe.skipIf(!DATABASE_URL)('delivery integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let merchantId: number;
  let townId: number;
  let zoneId: number;
  let addressId: number;
  let customerUlid: string;
  let customerId: number;
  let riderUlid: string;
  let riderId: number;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    const withTx = <T>(
      work: (repos: {
        delivery: ReturnType<typeof createKnexDeliveryRepo>;
        orders: ReturnType<typeof createKnexOrdersRepo>;
        ledger: ReturnType<typeof createKnexLedgerRepo>;
      }) => Promise<T>,
    ) =>
      db.transaction((trx) =>
        work({
          delivery: createKnexDeliveryRepo(trx),
          orders: createKnexOrdersRepo(trx),
          ledger: createKnexLedgerRepo(trx),
        }),
      );
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      delivery: {
        assignmentService: createAssignmentService({
          readRepo: createKnexDeliveryRepo(db),
          withTransaction: (work) =>
            db.transaction((trx) =>
              work({ delivery: createKnexDeliveryRepo(trx), orders: createKnexOrdersRepo(trx) }),
            ),
          config: {
            maxRadiusM: 50_000,
            offerTtlSec: 45,
            presenceFreshnessSec: 120,
            riderFeeFlatCents: 7_000,
          },
        }),
        deliveryService: createDeliveryService({
          readRepo: createKnexDeliveryRepo(db),
          withTransaction: withTx,
          ledgerService: createLedgerService(),
          auditService: createAuditService(createKnexAuthRepo(db)),
          config: { pinTtlSec: 900, pinMaxAttempts: 3 },
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
      'audit_log',
      'ledger_entry',
      'ledger_transaction',
      'ledger_account',
      'delivery_pin',
      'delivery',
      'assignment_offer',
      'order_status_history',
      'order',
      'rider_profile',
      'address',
      'merchant',
      'zone',
      'user_role',
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
          center_lat: CBD.lat,
          center_lng: CBD.lng,
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
          lat: CBD.lat,
          lng: CBD.lng,
        })
      )[0],
    );
    customerUlid = newUlid();
    customerId = Number(
      (
        await db('user').insert({
          ulid: customerUlid,
          phone_e164: '+254700000200',
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
          lat: CBD.lat,
          lng: CBD.lng,
        })
      )[0],
    );
    riderUlid = newUlid();
    riderId = Number(
      (
        await db('user').insert({ ulid: riderUlid, phone_e164: '+254700000201', status: 'active' })
      )[0],
    );
    await db('rider_profile').insert({
      user_id: riderId,
      vehicle_type: 'motorbike',
      status: 'approved',
    });
    const riderRole = (await db('role').where({ code: 'rider' }).first('id')) as {
      id: number | string;
    };
    await db('user_role').insert({ user_id: riderId, role_id: riderRole.id });
  });

  /** Seed a rider_assigned order + its assigned delivery (rider fee snapshot). */
  async function assignedOrder(): Promise<{ orderUlid: string }> {
    const orderUlid = newUlid();
    const orderId = Number(
      (
        await db('order').insert({
          ulid: orderUlid,
          order_number: `BOJ-${orderUlid.slice(-6)}`,
          customer_id: customerId,
          merchant_id: merchantId,
          town_id: townId,
          zone_id: zoneId,
          delivery_address_id: addressId,
          status: 'rider_assigned',
          payment_status: 'paid',
          subtotal_cents: 30_200,
          delivery_fee_cents: 10_000,
          total_cents: 40_200,
          commission_bps: 1_000,
          commission_cents: 3_020,
        })
      )[0],
    );
    await db('delivery').insert({
      order_id: orderId,
      rider_id: riderId,
      status: 'assigned',
      rider_fee_cents: 7_000,
    });
    return { orderUlid };
  }

  const riderAuth = () => ({ Authorization: `Bearer ${token(riderUlid, ['rider'])}` });
  const customerAuth = () => ({ Authorization: `Bearer ${token(customerUlid, ['customer'])}` });

  it('acceptance: pickup → start → PIN → complete leaves order delivered + a balanced rider earning', async () => {
    const { orderUlid } = await assignedOrder();
    expect(
      (await request(app).post(`/api/v1/rider/deliveries/${orderUlid}/pickup`).set(riderAuth()))
        .status,
    ).toBe(200);
    expect(
      (await request(app).post(`/api/v1/rider/deliveries/${orderUlid}/start`).set(riderAuth()))
        .status,
    ).toBe(200);

    const issued = await request(app)
      .post(`/api/v1/orders/${orderUlid}/delivery-pin`)
      .set(customerAuth());
    expect(issued.status).toBe(200);
    const pin = issued.body.pin as string;
    expect(pin).toMatch(/^\d{4}$/);

    const done = await request(app)
      .post(`/api/v1/rider/deliveries/${orderUlid}/complete`)
      .set(riderAuth())
      .send({ pin });
    expect(done.status).toBe(200);
    expect(done.body.orderStatus).toBe('delivered');

    const order = (await db('order').where({ ulid: orderUlid }).first('status')) as {
      status: string;
    };
    expect(order.status).toBe('delivered');
    const delivery = (await db('delivery').first('status', 'proof_type')) as {
      status: string;
      proof_type: string;
    };
    expect(delivery.status).toBe('delivered');
    expect(delivery.proof_type).toBe('pin');

    // Exactly one rider_earning transaction; the ledger balances; the fee lands in rider_payable.
    expect(await db('ledger_transaction').where({ kind: 'rider_earning' })).toHaveLength(1);
    const balances = await createKnexLedgerRepo(db).getAccountBalances();
    const debit = balances.reduce((s, b) => s + b.debitCents, 0);
    const credit = balances.reduce((s, b) => s + b.creditCents, 0);
    expect(debit).toBe(credit);
    const riderPayable = balances.find((b) => b.code === `rider_payable:${riderId}`);
    const platformDelivery = balances.find((b) => b.code === 'platform_delivery_income');
    expect(riderPayable?.creditCents).toBe(7_000);
    expect(platformDelivery?.debitCents).toBe(7_000);
  });

  it('a wrong PIN is rejected (409) and posts no earnings; a replayed complete is 409', async () => {
    const { orderUlid } = await assignedOrder();
    await request(app).post(`/api/v1/rider/deliveries/${orderUlid}/pickup`).set(riderAuth());
    await request(app).post(`/api/v1/rider/deliveries/${orderUlid}/start`).set(riderAuth());
    const pin = (
      await request(app).post(`/api/v1/orders/${orderUlid}/delivery-pin`).set(customerAuth())
    ).body.pin as string;

    const wrong = await request(app)
      .post(`/api/v1/rider/deliveries/${orderUlid}/complete`)
      .set(riderAuth())
      .send({ pin: `${pin}9` }); // 5 chars → never matches the 4-digit PIN
    expect(wrong.status).toBe(409);
    expect(await db('ledger_transaction').where({ kind: 'rider_earning' })).toHaveLength(0);

    // Correct PIN completes; a second complete is rejected (already delivered) — earnings stay at one.
    const first = await request(app)
      .post(`/api/v1/rider/deliveries/${orderUlid}/complete`)
      .set(riderAuth())
      .send({ pin });
    expect(first.status).toBe(200);
    const replay = await request(app)
      .post(`/api/v1/rider/deliveries/${orderUlid}/complete`)
      .set(riderAuth())
      .send({ pin });
    expect(replay.status).toBe(409);
    expect(await db('ledger_transaction').where({ kind: 'rider_earning' })).toHaveLength(1);
  });

  it('admin override completes a delivery without a PIN (audited)', async () => {
    const { orderUlid } = await assignedOrder();
    await request(app).post(`/api/v1/rider/deliveries/${orderUlid}/pickup`).set(riderAuth());
    await request(app).post(`/api/v1/rider/deliveries/${orderUlid}/start`).set(riderAuth());

    const res = await request(app)
      .post(`/api/v1/admin/deliveries/${orderUlid}/override-complete`)
      .set({ Authorization: `Bearer ${token('ADMIN', ['admin'])}` })
      .send({ reason: 'customer unreachable, confirmed by call' });
    expect(res.status).toBe(200);
    expect(res.body.orderStatus).toBe('delivered');
    expect(await db('ledger_transaction').where({ kind: 'rider_earning' })).toHaveLength(1);
    expect(await db('audit_log').where({ action: 'delivery.pin_override' })).toHaveLength(1);
  });
});
