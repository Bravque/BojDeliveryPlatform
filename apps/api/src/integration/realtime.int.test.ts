import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import request from 'supertest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newUlid } from '../auth/crypto';
import { signAccessToken } from '../auth/tokens';
import { createApp } from '../app';
import { createFulfillmentService } from '../orders/fulfillment-service';
import type { OrderService } from '../orders/order-service';
import { createKnexOrdersRepo } from '../orders/repo';
import { createRequireAuth } from '../middleware/auth';
import { createRealtimeEventPublisher } from '../platform/events/publisher';
import { createLateBoundGateway } from '../platform/realtime/gateway';
import { createKnexRealtimeResolver } from '../platform/realtime/resolver';
import { createRealtimeServer } from '../platform/realtime/server';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Realtime emission end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

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

describe.skipIf(!DATABASE_URL)('realtime emission integration (real MySQL)', () => {
  let db: Knex;
  let httpServer: HttpServer;
  let port: number;
  const clients: Socket[] = [];
  let townId: number;
  let zoneId: number;
  let merchantId: number;
  let merchantUlid: string;
  let ownerUlid: string;
  let customerUlid: string;
  let customerId: number;
  let addressId: number;

  beforeAll(async () => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    const resolver = createKnexRealtimeResolver(db);
    const lateGateway = createLateBoundGateway();
    const events = createRealtimeEventPublisher({
      gateway: lateGateway.gateway,
      resolver,
      logger: createLogger({ level: 'silent' }),
    });
    const app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      orders: {
        orderService: {} as unknown as OrderService, // unused — the test only hits the merchant route
        fulfillmentService: createFulfillmentService({
          withTransaction: (work) => db.transaction((trx) => work(createKnexOrdersRepo(trx))),
          events,
        }),
        requireAuth: createRequireAuth({ publicKey, issuer: ISSUER, audience: AUDIENCE }),
      },
    });
    httpServer = createServer(app);
    const realtime = createRealtimeServer(httpServer, {
      verifyOpts: { publicKey, issuer: ISSUER, audience: AUDIENCE },
      resolver,
      logger: createLogger({ level: 'silent' }),
    });
    lateGateway.bind(realtime.gateway);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const c of clients.splice(0)) c.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await db.destroy();
  });

  beforeEach(async () => {
    await db.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of [
      'order_status_history',
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
          name: 'CBD',
          center_lat: -1.0634,
          center_lng: 34.4731,
          radius_m: 3000,
          is_active: true,
        })
      )[0],
    );
    merchantUlid = newUlid();
    merchantId = Number(
      (
        await db('merchant').insert({
          ulid: merchantUlid,
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
    const ownerId = Number(
      (
        await db('user').insert({ ulid: ownerUlid, phone_e164: '+254700000210', status: 'active' })
      )[0],
    );
    await db('merchant_user').insert({ merchant_id: merchantId, user_id: ownerId, role: 'owner' });
    const ownerRole = (await db('role').where({ code: 'merchant_owner' }).first('id')) as {
      id: number | string;
    };
    await db('user_role').insert({ user_id: ownerId, role_id: ownerRole.id });
    customerUlid = newUlid();
    customerId = Number(
      (
        await db('user').insert({
          ulid: customerUlid,
          phone_e164: '+254700000211',
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

  function connect(tok: string): Promise<Socket> {
    const socket = ioClient(`http://localhost:${port}`, {
      auth: { token: tok },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    clients.push(socket);
    return new Promise((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  }

  const join = (socket: Socket, room: string): Promise<{ ok: boolean }> =>
    new Promise((resolve) => socket.emit('join', room, resolve));
  const once = (socket: Socket, event: string): Promise<Record<string, unknown>> =>
    new Promise((resolve) => socket.once(event, resolve));

  it('a REST transition pushes status.changed (order room) + order.updated (merchant room)', async () => {
    const orderUlid = await placedOrder();

    const customer = await connect(token(customerUlid, ['customer']));
    const merchant = await connect(token(ownerUlid, ['merchant_owner']));
    expect(await join(customer, `order:${orderUlid}`)).toEqual({ ok: true });
    expect(await join(merchant, `merchant:${merchantUlid}`)).toEqual({ ok: true });

    const onOrder = once(customer, 'status.changed');
    const onMerchant = once(merchant, 'order.updated');

    const res = await request(httpServer)
      .post(`/api/v1/merchant/orders/${orderUlid}/accept`)
      .set('Authorization', `Bearer ${token(ownerUlid, ['merchant_owner'])}`);
    expect(res.status).toBe(200);

    expect(await onOrder).toMatchObject({ orderUlid, status: 'merchant_accepted' });
    expect(await onMerchant).toMatchObject({ orderUlid, status: 'merchant_accepted' });
  });

  it('does not deliver order events to a socket that never joined the room', async () => {
    const orderUlid = await placedOrder();
    const merchant = await connect(token(ownerUlid, ['merchant_owner']));
    await join(merchant, `merchant:${merchantUlid}`);

    // A stranger customer socket that joins nothing must not receive this order's events.
    const stranger = await connect(token(customerUlid, ['customer']));
    let received = false;
    stranger.onAny(() => {
      received = true;
    });

    const onMerchant = once(merchant, 'order.updated');
    await request(httpServer)
      .post(`/api/v1/merchant/orders/${orderUlid}/accept`)
      .set('Authorization', `Bearer ${token(ownerUlid, ['merchant_owner'])}`);
    await onMerchant; // the merchant (joined) did receive it
    expect(received).toBe(false);
  });
});
