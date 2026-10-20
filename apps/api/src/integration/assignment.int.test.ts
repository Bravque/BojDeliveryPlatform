import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newUlid } from '../auth/crypto';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createAssignmentService } from '../delivery/assignment-service';
import { createDeliveryService } from '../delivery/delivery-service';
import { createKnexDeliveryRepo } from '../delivery/repo';
import { createKnexOrdersRepo } from '../orders/repo';
import { createAuditService } from '../auth/audit-service';
import { createKnexAuthRepo } from '../auth/repo';
import { createLedgerService } from '../ledger/ledger-service';
import { createKnexLedgerRepo } from '../ledger/repo';
import { createRequireAuth } from '../middleware/auth';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Rider assignment end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;
const CBD = { lat: -1.0634, lng: 34.4731 };

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

describe.skipIf(!DATABASE_URL)('rider assignment integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let townId: number;
  let zoneId: number;
  let merchantId: number;
  let customerId: number;
  let addressId: number;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
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
          withTransaction: (work) =>
            db.transaction((trx) =>
              work({
                delivery: createKnexDeliveryRepo(trx),
                orders: createKnexOrdersRepo(trx),
                ledger: createKnexLedgerRepo(trx),
              }),
            ),
          ledgerService: createLedgerService(),
          auditService: createAuditService(createKnexAuthRepo(db)),
          config: { pinTtlSec: 900, pinMaxAttempts: 5 },
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
      'delivery',
      'assignment_offer',
      'order_status_history',
      'order_item',
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
          name: 'Migori CBD',
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
          lat: CBD.lat,
          lng: CBD.lng,
        })
      )[0],
    );
  });

  let phoneSeq = 0;
  async function seedRider(
    opts: { lat?: number; lng?: number; online?: boolean; fresh?: boolean } = {},
  ) {
    phoneSeq += 1;
    const ulid = newUlid();
    const userId = Number(
      (
        await db('user').insert({
          ulid,
          phone_e164: `+2547011000${String(phoneSeq).padStart(2, '0')}`,
          status: 'active',
        })
      )[0],
    );
    await db('rider_profile').insert({
      user_id: userId,
      vehicle_type: 'motorbike',
      status: 'approved',
      is_online: opts.online ?? true,
      last_lat: opts.lat ?? CBD.lat,
      last_lng: opts.lng ?? CBD.lng,
      last_ping_at: (opts.fresh ?? true) ? db.raw('NOW(3)') : db.raw('NOW(3) - INTERVAL 1 HOUR'),
    });
    const riderRole = (await db('role').where({ code: 'rider' }).first('id')) as {
      id: number | string;
    };
    await db('user_role').insert({ user_id: userId, role_id: riderRole.id });
    const token = signAccessToken(
      { sub: ulid, roles: ['rider'], jti: 'j' },
      { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
    );
    return { userId, ulid, token, auth: { Authorization: `Bearer ${token}` } };
  }

  async function readyOrder(): Promise<{ orderId: number; orderUlid: string }> {
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
          status: 'ready_for_pickup',
          payment_status: 'paid',
          subtotal_cents: 30_200,
          delivery_fee_cents: 10_000,
          total_cents: 40_200,
          commission_bps: 1_000,
          commission_cents: 3_020,
        })
      )[0],
    );
    return { orderId, orderUlid };
  }

  const opsAuth = () => ({
    Authorization: `Bearer ${signAccessToken(
      { sub: 'OPS', roles: ['ops'], jti: 'j' },
      { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
    )}`,
  });

  it('acceptance: K concurrent accepts → exactly one winner, the rest 409, one delivery', async () => {
    const { orderId } = await readyOrder();
    const riders = await Promise.all([
      seedRider(),
      seedRider(),
      seedRider(),
      seedRider(),
      seedRider(),
    ]);
    // One live offer per rider for the same order (a broadcast race).
    const offerIds: number[] = [];
    for (const r of riders) {
      const [id] = await db('assignment_offer').insert({
        order_id: orderId,
        rider_id: r.userId,
        expires_at: db.raw('NOW(3) + INTERVAL 1 HOUR'),
      });
      offerIds.push(Number(id));
    }

    const results = await Promise.all(
      riders.map((r, i) =>
        request(app).post(`/api/v1/rider/offers/${offerIds[i]}/accept`).set(r.auth),
      ),
    );
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
    expect(results.filter((x) => x.status === 409)).toHaveLength(riders.length - 1);

    expect(await db('delivery').where({ order_id: orderId })).toHaveLength(1);
    const order = (await db('order').where({ id: orderId }).first('status')) as { status: string };
    expect(order.status).toBe('rider_assigned');
    const accepted = await db('assignment_offer').where({ order_id: orderId, status: 'accepted' });
    expect(accepted).toHaveLength(1);
  });

  it('tick offers a ready order to the nearest candidate; decline re-offers the next', async () => {
    const { orderId } = await readyOrder();
    const near = await seedRider({ lat: CBD.lat, lng: CBD.lng }); // at the merchant
    const far = await seedRider({ lat: CBD.lat + 0.01, lng: CBD.lng }); // ~1.1 km away

    const tick = await request(app).post('/api/v1/admin/assignments/tick').set(opsAuth());
    expect(tick.status).toBe(200);
    expect(tick.body.offered).toBe(1);

    const firstOffer = (await db('assignment_offer')
      .where({ order_id: orderId, status: 'offered' })
      .first('id', 'rider_id')) as { id: number; rider_id: number };
    expect(Number(firstOffer.rider_id)).toBe(near.userId);

    const decline = await request(app)
      .post(`/api/v1/rider/offers/${firstOffer.id}/decline`)
      .set(near.auth);
    expect(decline.status).toBe(200);
    expect(decline.body.offered).toBe(true);

    const live = (await db('assignment_offer')
      .where({ order_id: orderId, status: 'offered' })
      .first('rider_id')) as { rider_id: number };
    expect(Number(live.rider_id)).toBe(far.userId); // re-offered to the next candidate
  });

  it('exhaustion: a ready order with no eligible riders stays ready_for_pickup (no offer)', async () => {
    const { orderId } = await readyOrder();
    await seedRider({ online: false }); // offline → not a candidate

    const tick = await request(app).post('/api/v1/admin/assignments/tick').set(opsAuth());
    expect(tick.status).toBe(200);
    expect(tick.body.scanned).toBe(1);
    expect(tick.body.offered).toBe(0);

    expect(await db('assignment_offer').where({ order_id: orderId })).toHaveLength(0);
    const order = (await db('order').where({ id: orderId }).first('status')) as { status: string };
    expect(order.status).toBe('ready_for_pickup');
  });

  it('expired offer → 409 OFFER_EXPIRED on accept', async () => {
    const { orderId } = await readyOrder();
    const rider = await seedRider();
    const [offerId] = await db('assignment_offer').insert({
      order_id: orderId,
      rider_id: rider.userId,
      expires_at: db.raw('NOW(3) - INTERVAL 1 MINUTE'), // already expired
    });
    const res = await request(app).post(`/api/v1/rider/offers/${offerId}/accept`).set(rider.auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OFFER_EXPIRED');
  });
});
