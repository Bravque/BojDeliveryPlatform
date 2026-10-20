import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newUlid } from '../auth/crypto';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import { createFulfillmentService } from '../orders/fulfillment-service';
import { createOrderService } from '../orders/order-service';
import { createKnexOrdersRepo } from '../orders/repo';
import { createAuditService } from '../auth/audit-service';
import { createKnexAuthRepo } from '../auth/repo';
import { createFeeService } from '../fees/fee-service';
import { createKnexDeliveryFeeRuleRepo } from '../fees/repo';
import { createKnexZoneRepo } from '../zones/repo';
import { createZoneService } from '../zones/zone-service';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Merchant order progression end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

describe.skipIf(!DATABASE_URL)('merchant order progression integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let townId: number;
  let zoneId: number;
  let merchantId: number;
  let customerId: number;
  let addressId: number;
  let ownerUlid: string;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    const auditService = createAuditService(createKnexAuthRepo(db));
    const withTransaction = <T>(
      work: (repo: ReturnType<typeof createKnexOrdersRepo>) => Promise<T>,
    ) => db.transaction((trx) => work(createKnexOrdersRepo(trx)));
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      orders: {
        orderService: createOrderService({
          readRepo: createKnexOrdersRepo(db),
          withTransaction,
          zones: createZoneService({ repo: createKnexZoneRepo(db), auditService }),
          fees: createFeeService({ repo: createKnexDeliveryFeeRuleRepo(db), auditService }),
        }),
        fulfillmentService: createFulfillmentService({ withTransaction }),
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
      'order_status_history',
      'order_item',
      'order',
      'merchant_user',
      'merchant',
      'address',
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
        await db('user').insert({ ulid: newUlid(), phone_e164: '+254700000180', status: 'active' })
      )[0],
    );
    // A merchant owner who is a member of this merchant (owns its orders) + has the global role.
    ownerUlid = newUlid();
    const ownerId = Number(
      (
        await db('user').insert({ ulid: ownerUlid, phone_e164: '+254700000181', status: 'active' })
      )[0],
    );
    await db('merchant_user').insert({ merchant_id: merchantId, user_id: ownerId, role: 'owner' });
    const ownerRole = (await db('role').where({ code: 'merchant_owner' }).first('id')) as {
      id: number | string;
    };
    await db('user_role').insert({ user_id: ownerId, role_id: ownerRole.id });
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

  /** Seed a `placed` + paid order ready for the merchant to act on. */
  async function placedOrder(): Promise<string> {
    const orderUlid = newUlid();
    await db('order').insert({
      ulid: orderUlid,
      order_number: `BOJ-${orderUlid.slice(-6)}`,
      customer_id: customerId,
      merchant_id: merchantId,
      town_id: townId,
      zone_id: zoneId,
      delivery_address_id: addressId,
      status: 'placed',
      payment_status: 'paid',
      subtotal_cents: 30_200,
      delivery_fee_cents: 10_000,
      total_cents: 40_200,
      commission_bps: 1_000,
      commission_cents: 3_020,
    });
    return orderUlid;
  }

  const ownerAuth = () => ({
    Authorization: `Bearer ${signAccessToken(
      { sub: ownerUlid, roles: ['merchant_owner'], jti: 'j' },
      { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
    )}`,
  });

  it('accept → preparing → ready records history and lands on ready_for_pickup', async () => {
    const orderUlid = await placedOrder();

    for (const [path, expected] of [
      ['accept', 'merchant_accepted'],
      ['preparing', 'preparing'],
      ['ready', 'ready_for_pickup'],
    ] as const) {
      const res = await request(app)
        .post(`/api/v1/merchant/orders/${orderUlid}/${path}`)
        .set(ownerAuth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(expected);
    }

    const order = (await db('order').where({ ulid: orderUlid }).first('id', 'status')) as {
      id: number;
      status: string;
    };
    expect(order.status).toBe('ready_for_pickup');
    const history = await db('order_status_history')
      .where({ order_id: order.id })
      .whereIn('to_status', ['merchant_accepted', 'preparing', 'ready_for_pickup']);
    expect(history).toHaveLength(3);
  });

  it('rejects an illegal transition with 409 (ready before accept)', async () => {
    const orderUlid = await placedOrder();
    const res = await request(app)
      .post(`/api/v1/merchant/orders/${orderUlid}/ready`)
      .set(ownerAuth());
    expect(res.status).toBe(409);
  });

  it('reject sets rejected (reason recorded); payment_status untouched (no refund here)', async () => {
    const orderUlid = await placedOrder();
    const res = await request(app)
      .post(`/api/v1/merchant/orders/${orderUlid}/reject`)
      .set(ownerAuth())
      .send({ reason: 'kitchen closed' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');

    const order = (await db('order')
      .where({ ulid: orderUlid })
      .first('status', 'cancelled_reason', 'payment_status')) as {
      status: string;
      cancelled_reason: string | null;
      payment_status: string;
    };
    expect(order.status).toBe('rejected');
    expect(order.cancelled_reason).toBe('kitchen closed');
    // Reject is status-only — money movement stays with the refund flow, so payment is untouched.
    expect(order.payment_status).toBe('paid');
  });

  it('forbids a merchant who does not own the order (403)', async () => {
    const orderUlid = await placedOrder();
    const strangerUlid = newUlid();
    await db('user').insert({ ulid: strangerUlid, phone_e164: '+254700000182', status: 'active' });
    const res = await request(app)
      .post(`/api/v1/merchant/orders/${orderUlid}/accept`)
      .set({
        Authorization: `Bearer ${signAccessToken(
          { sub: strangerUlid, roles: ['merchant_owner'], jti: 'j' },
          { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
        )}`,
      });
    expect(res.status).toBe(403);
  });
});
