import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockSmsProvider } from '../auth/sms/mock';
import { newUlid } from '../auth/crypto';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createRequireAuth } from '../middleware/auth';
import { createDeviceService } from '../notifications/device-service';
import {
  createNotificationDispatcher,
  type NotificationDispatcher,
} from '../notifications/dispatcher';
import { MockPushProvider } from '../notifications/mock-push';
import { createKnexNotificationsRepo } from '../notifications/repo';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Notifications end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

describe.skipIf(!DATABASE_URL)('notifications integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let push: MockPushProvider;
  let sms: MockSmsProvider;
  let dispatcher: NotificationDispatcher;
  let townId: number;
  let zoneId: number;
  let merchantId: number;
  let ownerUlid: string;
  let ownerId: number;
  let customerId: number;
  let customerUlid: string;
  let addressId: number;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    const repo = createKnexNotificationsRepo(db);
    push = new MockPushProvider();
    sms = new MockSmsProvider();
    dispatcher = createNotificationDispatcher({
      repo,
      push,
      sms,
      logger: createLogger({ level: 'silent' }),
    });
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      notifications: {
        deviceService: createDeviceService({ repo }),
        requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
      },
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    push.sent.splice(0);
    sms.sent.splice(0);
    await db.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of [
      'notification',
      'device',
      'order',
      'merchant_user',
      'merchant',
      'address',
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
    ownerUlid = newUlid();
    ownerId = Number(
      (
        await db('user').insert({ ulid: ownerUlid, phone_e164: '+254700000220', status: 'active' })
      )[0],
    );
    await db('merchant_user').insert({ merchant_id: merchantId, user_id: ownerId, role: 'owner' });
    customerUlid = newUlid();
    customerId = Number(
      (
        await db('user').insert({
          ulid: customerUlid,
          phone_e164: '+254700000221',
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
  });

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

  const ownerToken = () =>
    signAccessToken(
      { sub: ownerUlid, roles: ['merchant_owner'], jti: 'j' },
      { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
    );

  it('registers a push token via POST /devices (upsert)', async () => {
    const res = await request(app)
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ pushToken: 'expo-tok-owner', platform: 'android' });
    expect(res.status).toBe(201);

    const row = (await db('device').where({ push_token: 'expo-tok-owner' }).first('user_id')) as {
      user_id: number | string;
    };
    expect(Number(row.user_id)).toBe(ownerId);

    // Re-registering the same token is an upsert (still one row).
    await request(app)
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ pushToken: 'expo-tok-owner', platform: 'ios' });
    expect(await db('device').where({ push_token: 'expo-tok-owner' })).toHaveLength(1);
  });

  it('dispatches a placed order to the merchant via push + records it', async () => {
    const orderUlid = await placedOrder();
    await db('device').insert({ user_id: ownerId, push_token: 'tok-owner', platform: 'android' });

    await dispatcher.handle(orderUlid, 'placed');

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.token).toBe('tok-owner');
    const notif = (await db('notification').where({ user_id: ownerId }).first()) as {
      channel: string;
      kind: string;
      status: string;
    };
    expect(notif).toMatchObject({ channel: 'push', kind: 'order.new', status: 'sent' });
  });

  it('falls back to SMS for the customer when they have no device (rider_assigned)', async () => {
    const orderUlid = await placedOrder();
    await dispatcher.handle(orderUlid, 'rider_assigned');

    expect(push.sent).toHaveLength(0);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]?.to).toBe('+254700000221');
    const notif = (await db('notification')
      .where({ user_id: customerId })
      .first('channel', 'kind')) as {
      channel: string;
      kind: string;
    };
    expect(notif).toMatchObject({ channel: 'sms', kind: 'rider.assigned' });
  });
});
