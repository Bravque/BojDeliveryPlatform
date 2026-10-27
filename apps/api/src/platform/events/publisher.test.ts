import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger';
import type { RealtimeGateway } from '../realtime/gateway';
import type { RealtimeResolver } from '../realtime/authorize';
import {
  combinePublishers,
  createRealtimeEventPublisher,
  type DomainEventPublisher,
} from './publisher';

interface Captured {
  ulid: string;
  event: string;
  payload: unknown;
}

function spyGateway() {
  const order: Captured[] = [];
  const merchant: Captured[] = [];
  const rider: Captured[] = [];
  const gateway: RealtimeGateway = {
    emitOrder: (ulid, event, payload) => order.push({ ulid, event, payload }),
    emitMerchant: (ulid, event, payload) => merchant.push({ ulid, event, payload }),
    emitRider: (ulid, event, payload) => rider.push({ ulid, event, payload }),
  };
  return { gateway, order, merchant, rider };
}

const resolver: Pick<RealtimeResolver, 'orderParticipants'> = {
  orderParticipants: (ulid) =>
    Promise.resolve(
      ulid === 'ORD1' ? { customerUlid: 'CUST', merchantUlid: 'MERCH', riderUlid: null } : null,
    ),
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createRealtimeEventPublisher', () => {
  it('emits status.changed to the order room (synchronously)', () => {
    const spy = spyGateway();
    const pub = createRealtimeEventPublisher({
      gateway: spy.gateway,
      resolver,
      logger: createLogger({ level: 'silent' }),
    });
    pub.orderStatusChanged('ORD1', 'merchant_accepted');
    expect(spy.order).toEqual([
      {
        ulid: 'ORD1',
        event: 'status.changed',
        payload: { orderUlid: 'ORD1', status: 'merchant_accepted' },
      },
    ]);
  });

  it('emits order.updated to the merchant room for a non-placed transition', async () => {
    const spy = spyGateway();
    const pub = createRealtimeEventPublisher({
      gateway: spy.gateway,
      resolver,
      logger: createLogger({ level: 'silent' }),
    });
    pub.orderStatusChanged('ORD1', 'merchant_accepted');
    await flush();
    expect(spy.merchant).toEqual([
      {
        ulid: 'MERCH',
        event: 'order.updated',
        payload: { orderUlid: 'ORD1', status: 'merchant_accepted' },
      },
    ]);
  });

  it('emits order.new to the merchant room when an order is placed', async () => {
    const spy = spyGateway();
    const pub = createRealtimeEventPublisher({
      gateway: spy.gateway,
      resolver,
      logger: createLogger({ level: 'silent' }),
    });
    pub.orderStatusChanged('ORD1', 'placed');
    await flush();
    expect(spy.merchant[0]).toMatchObject({ ulid: 'MERCH', event: 'order.new' });
  });

  it('skips the merchant emit when the order is unknown (no throw)', async () => {
    const spy = spyGateway();
    const pub = createRealtimeEventPublisher({
      gateway: spy.gateway,
      resolver,
      logger: createLogger({ level: 'silent' }),
    });
    pub.orderStatusChanged('UNKNOWN', 'placed');
    await flush();
    expect(spy.order).toHaveLength(1); // order room still gets status.changed
    expect(spy.merchant).toHaveLength(0);
  });

  it('emits offer.new to the chosen rider room', () => {
    const spy = spyGateway();
    const pub = createRealtimeEventPublisher({
      gateway: spy.gateway,
      resolver,
      logger: createLogger({ level: 'silent' }),
    });
    pub.riderOffered('RIDER1', {
      offerId: 7,
      orderUlid: 'ORD1',
      expiresAt: '2026-10-27T10:00:00Z',
    });
    expect(spy.rider).toEqual([
      {
        ulid: 'RIDER1',
        event: 'offer.new',
        payload: { offerId: 7, orderUlid: 'ORD1', expiresAt: '2026-10-27T10:00:00Z' },
      },
    ]);
  });
});

describe('combinePublishers', () => {
  it('fans an event out to every publisher', () => {
    const calls: string[] = [];
    const a: DomainEventPublisher = {
      orderStatusChanged: () => calls.push('a'),
      riderOffered: () => calls.push('a:offer'),
    };
    const b: DomainEventPublisher = {
      orderStatusChanged: () => calls.push('b'),
      riderOffered: () => calls.push('b:offer'),
    };
    const combined = combinePublishers(a, b);
    combined.orderStatusChanged('ORD1', 'placed');
    combined.riderOffered('RIDER1', { offerId: 1, orderUlid: 'ORD1', expiresAt: 'x' });
    expect(calls).toEqual(['a', 'b', 'a:offer', 'b:offer']);
  });
});
