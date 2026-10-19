import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newUlid } from '../auth/crypto';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import { createPaymentService } from '../payments/payment-service';
import { createKnexPaymentsRepo } from '../payments/repo';
import { SimulatedGateway } from '../payments/simulated-gateway';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Payment initiation end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

describe.skipIf(!DATABASE_URL)('payments integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let custToken: string;
  let orderUlid: string;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      payments: {
        paymentService: createPaymentService({
          readRepo: createKnexPaymentsRepo(db),
          withTransaction: (work) => db.transaction((trx) => work(createKnexPaymentsRepo(trx))),
          gateway: new SimulatedGateway(),
          method: 'simulated',
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
      'payment_event',
      'payment',
      'order_status_history',
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

    const [townId] = await db('town').insert({ ulid: newUlid(), name: 'Migori', is_active: true });
    const custUlid = newUlid();
    const [userId] = await db('user').insert({
      ulid: custUlid,
      phone_e164: '+254700000120',
      status: 'active',
    });
    custToken = signAccessToken(
      { sub: custUlid, roles: ['customer'], jti: 'j' },
      { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
    );
    const [zoneId] = await db('zone').insert({
      ulid: newUlid(),
      town_id: townId,
      name: 'Migori CBD',
      center_lat: -1.0634,
      center_lng: 34.4731,
      radius_m: 3000,
      is_active: true,
    });
    const [merchantId] = await db('merchant').insert({
      ulid: newUlid(),
      town_id: townId,
      name: 'Joe Kitchen',
      category_type: 'restaurant',
      status: 'approved',
      is_open: true,
      commission_bps: 1_000,
    });
    const [addressId] = await db('address').insert({
      ulid: newUlid(),
      user_id: userId,
      line1: 'Market Rd',
      lat: -1.0634,
      lng: 34.4731,
    });
    orderUlid = newUlid();
    await db('order').insert({
      ulid: orderUlid,
      order_number: 'BOJ-TEST0001',
      customer_id: userId,
      merchant_id: merchantId,
      town_id: townId,
      zone_id: zoneId,
      delivery_address_id: addressId,
      status: 'draft',
      subtotal_cents: 30_200,
      delivery_fee_cents: 10_000,
      total_cents: 40_200,
      commission_bps: 1_000,
      commission_cents: 3_020,
    });
  });

  const auth = () => ({ Authorization: `Bearer ${custToken}` });

  it('initiates an STK push: payment pending, order → payment_pending, history recorded', async () => {
    const res = await request(app)
      .post(`/api/v1/orders/${orderUlid}/pay`)
      .set(auth())
      .set('Idempotency-Key', 'pay-key-1')
      .send({ phone: '+254700000120' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(res.body.amountCents).toBe(40_200);

    const payment = (await db('payment').where({ ulid: res.body.ulid }).first()) as {
      status: string;
      checkout_request_id: string | null;
      amount_cents: number;
    };
    expect(payment.status).toBe('pending');
    expect(payment.checkout_request_id).toMatch(/^SIM-/);
    expect(Number(payment.amount_cents)).toBe(40_200);

    const order = (await db('order').where({ ulid: orderUlid }).first('status')) as {
      status: string;
    };
    expect(order.status).toBe('payment_pending');
    const history = await db('order_status_history').where({ to_status: 'payment_pending' });
    expect(history).toHaveLength(1);
  });

  it('is idempotent: replaying the same Idempotency-Key yields one payment', async () => {
    const first = await request(app)
      .post(`/api/v1/orders/${orderUlid}/pay`)
      .set(auth())
      .set('Idempotency-Key', 'pay-key-2')
      .send({});
    const second = await request(app)
      .post(`/api/v1/orders/${orderUlid}/pay`)
      .set(auth())
      .set('Idempotency-Key', 'pay-key-2')
      .send({});
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.ulid).toBe(first.body.ulid);
    expect(await db('payment')).toHaveLength(1);

    const got = await request(app).get(`/api/v1/payments/${first.body.ulid}`).set(auth());
    expect(got.status).toBe(200);
    expect(got.body.orderUlid).toBe(orderUlid);
  });
});
