import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newUlid } from '../auth/crypto';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import { createPresenceService } from '../riders/presence-service';
import { createRiderService } from '../riders/rider-service';
import { createKnexRiderRepo } from '../riders/repo';
import { createKnexPayoutsRepo } from '../payouts/repo';
import { createAuditService } from '../auth/audit-service';
import { createKnexAuthRepo } from '../auth/repo';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/**
 * Rider earnings + payout destination end-to-end against a real MySQL. Proves `GET /rider/earnings`
 * sums rider fees over delivered deliveries, `POST /rider/payout-destination` normalises to E.164 and
 * `GET /rider/me` reflects it, and the payout payee-MSISDN resolver prefers the override. Self-skips
 * without DATABASE_URL.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

describe.skipIf(!DATABASE_URL)('rider earnings + payout integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let riderUlid: string;
  let riderUserId: number;
  let townId: number;
  let zoneId: number;
  let merchantId: number;
  let customerId: number;
  let addressId: number;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    const repo = createKnexRiderRepo(db);
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      riders: {
        riderService: createRiderService({
          repo,
          auditService: createAuditService(createKnexAuthRepo(db)),
        }),
        presenceService: createPresenceService({ repo, pingMinIntervalSec: 10 }),
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
      'delivery',
      'order',
      'address',
      'merchant',
      'zone',
      'rider_profile',
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
    customerId = Number(
      (
        await db('user').insert({ ulid: newUlid(), phone_e164: '+254700000190', status: 'active' })
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

    riderUlid = newUlid();
    riderUserId = Number(
      (
        await db('user').insert({ ulid: riderUlid, phone_e164: '+254700000170', status: 'active' })
      )[0],
    );
    await db('rider_profile').insert({
      user_id: riderUserId,
      vehicle_type: 'motorbike',
      status: 'approved',
    });
    const riderRole = (await db('role').where({ code: 'rider' }).first('id')) as {
      id: number | string;
    };
    await db('user_role').insert({ user_id: riderUserId, role_id: riderRole.id });
  });

  const riderAuth = () => ({
    Authorization: `Bearer ${signAccessToken(
      { sub: riderUlid, roles: ['rider'], jti: 'j' },
      { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
    )}`,
  });

  /** Seed a delivered delivery for this rider with the given fee. */
  async function seedDeliveredDelivery(feeCents: number): Promise<void> {
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
          status: 'delivered',
          payment_status: 'paid',
          subtotal_cents: 50_000,
          delivery_fee_cents: 10_000,
          total_cents: 60_000,
          commission_bps: 1_000,
          commission_cents: 5_000,
        })
      )[0],
    );
    await db('delivery').insert({
      order_id: orderId,
      rider_id: riderUserId,
      status: 'delivered',
      rider_fee_cents: feeCents,
      proof_type: 'pin',
      delivered_at: db.raw('CURRENT_TIMESTAMP(3)'),
    });
  }

  it('GET /rider/earnings sums rider fees over delivered deliveries', async () => {
    const zero = await request(app).get('/api/v1/rider/earnings').set(riderAuth());
    expect(zero.status).toBe(200);
    expect(zero.body).toEqual({ deliveries: 0, totalEarnedCents: 0 });

    await seedDeliveredDelivery(7_000);
    await seedDeliveredDelivery(5_000);

    const res = await request(app).get('/api/v1/rider/earnings').set(riderAuth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deliveries: 2, totalEarnedCents: 12_000 });
  });

  it('POST /rider/payout-destination normalises to E.164 and /rider/me reflects it', async () => {
    const set = await request(app)
      .post('/api/v1/rider/payout-destination')
      .set(riderAuth())
      .send({ phone: '0712345678' });
    expect(set.status).toBe(200);
    expect(set.body.payoutPhoneE164).toBe('+254712345678');

    const me = await request(app).get('/api/v1/rider/me').set(riderAuth());
    expect(me.body.payoutPhoneE164).toBe('+254712345678');

    const bad = await request(app)
      .post('/api/v1/rider/payout-destination')
      .set(riderAuth())
      .send({ phone: 'not-a-phone' });
    expect(bad.status).toBe(400);
  });

  it('payout payee MSISDN prefers the override, falling back to the sign-in number', async () => {
    const payouts = createKnexPayoutsRepo(db);
    // No override yet → falls back to the rider's user.phone_e164.
    expect(await payouts.getPayeeMsisdn('rider', riderUserId)).toBe('+254700000170');

    await request(app)
      .post('/api/v1/rider/payout-destination')
      .set(riderAuth())
      .send({ phone: '0798765432' });
    expect(await payouts.getPayeeMsisdn('rider', riderUserId)).toBe('+254798765432');
  });
});
