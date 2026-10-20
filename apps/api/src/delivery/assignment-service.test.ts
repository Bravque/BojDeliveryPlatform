import { describe, expect, it } from 'vitest';
import type { OrdersRepo } from '../orders/repo';
import { createAssignmentService, type Actor } from './assignment-service';
import type { CandidateRow, DeliveryRecord, DeliveryRepo, OfferRecord, OfferStatus } from './repo';

const CONFIG = {
  maxRadiusM: 50_000,
  offerTtlSec: 45,
  presenceFreshnessSec: 120,
  riderFeeFlatCents: 7_000,
};

function makeWorld(over: { candidates?: CandidateRow[] } = {}) {
  const order = {
    id: 1,
    ulid: 'ORD1',
    status: 'ready_for_pickup' as string,
    deliveryFeeCents: 10_000,
    merchantLat: 0 as number | null,
    merchantLng: 0 as number | null,
  };
  const usersByUlid = new Map<string, number>([
    ['rider10', 10],
    ['rider11', 11],
  ]);
  const offers: OfferRecord[] = [];
  const deliveries: DeliveryRecord[] = [];
  const history: Array<{ toStatus: string; actorType: string }> = [];
  const candidates: CandidateRow[] = over.candidates ?? [{ userId: 10, lat: 0, lng: 0 }];
  let offerSeq = 0;
  let delSeq = 0;

  const delivery = {
    findUserIdByUlid: (ulid: string) => Promise.resolve(usersByUlid.get(ulid) ?? null),
    getAssignmentContext: (ulid: string) =>
      Promise.resolve(
        ulid === order.ulid
          ? {
              orderId: order.id,
              orderUlid: order.ulid,
              status: order.status,
              deliveryFeeCents: order.deliveryFeeCents,
              merchantLat: order.merchantLat,
              merchantLng: order.merchantLng,
            }
          : null,
      ),
    listCandidateRiders: () => Promise.resolve(candidates),
    listOfferedRiderIds: (orderId: number) =>
      Promise.resolve(offers.filter((o) => o.orderId === orderId).map((o) => o.riderId)),
    insertOffer: (input: { orderId: number; riderId: number; expiresAt: Date }) => {
      const id = ++offerSeq;
      offers.push({
        id,
        orderId: input.orderId,
        orderUlid: order.ulid,
        riderId: input.riderId,
        status: 'offered',
        expiresAt: input.expiresAt,
      });
      return Promise.resolve(id);
    },
    findLiveOffer: (orderId: number, now: Date) =>
      Promise.resolve(
        offers.find((o) => o.orderId === orderId && o.status === 'offered' && o.expiresAt > now) ??
          null,
      ),
    findOfferById: (id: number) => Promise.resolve(offers.find((o) => o.id === id) ?? null),
    lockOfferById: (id: number) => Promise.resolve(offers.find((o) => o.id === id) ?? null),
    markOfferStatus: (id: number, status: OfferStatus) => {
      const o = offers.find((x) => x.id === id);
      if (o) o.status = status;
      return Promise.resolve();
    },
    supersedeOtherOffers: (orderId: number, except: number) => {
      offers.forEach((o) => {
        if (o.orderId === orderId && o.id !== except && o.status === 'offered') {
          o.status = 'superseded';
        }
      });
      return Promise.resolve();
    },
    listLiveOffersForRider: (riderId: number, now: Date) =>
      Promise.resolve(
        offers
          .filter((o) => o.riderId === riderId && o.status === 'offered' && o.expiresAt > now)
          .map((o) => ({
            offerId: o.id,
            orderUlid: o.orderUlid,
            expiresAt: o.expiresAt.toISOString(),
          })),
      ),
    expireStaleOffers: (now: Date) => {
      let n = 0;
      offers.forEach((o) => {
        if (o.status === 'offered' && o.expiresAt <= now) {
          o.status = 'expired';
          n += 1;
        }
      });
      return Promise.resolve(n);
    },
    listReadyOrdersForAssignment: (now: Date) =>
      Promise.resolve(
        order.status === 'ready_for_pickup' &&
          !offers.some(
            (o) => o.orderId === order.id && o.status === 'offered' && o.expiresAt > now,
          ) &&
          !deliveries.some((d) => d.orderId === order.id)
          ? [order.ulid]
          : [],
      ),
    insertDelivery: (input: {
      orderId: number;
      riderId: number;
      status: DeliveryRecord['status'];
      riderFeeCents: number;
    }) => {
      if (deliveries.some((d) => d.orderId === input.orderId)) {
        return Promise.reject(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }));
      }
      const id = ++delSeq;
      deliveries.push({ id, ...input });
      return Promise.resolve(id);
    },
    findDeliveryByOrderId: (orderId: number) =>
      Promise.resolve(deliveries.find((d) => d.orderId === orderId) ?? null),
  } as unknown as DeliveryRepo;

  const orders = {
    findUserIdByUlid: (ulid: string) => Promise.resolve(usersByUlid.get(ulid) ?? null),
    lockOrderByUlid: (ulid: string) =>
      Promise.resolve(
        ulid === order.ulid
          ? {
              id: order.id,
              ulid: order.ulid,
              status: order.status,
              deliveryFeeCents: order.deliveryFeeCents,
            }
          : null,
      ),
    setOrderStatus: (_id: number, status: string) => {
      order.status = status;
      return Promise.resolve();
    },
    insertStatusHistory: (h: { toStatus: string; actorType: string }) => {
      history.push({ toStatus: h.toStatus, actorType: h.actorType });
      return Promise.resolve();
    },
  } as unknown as OrdersRepo;

  const svc = createAssignmentService({
    readRepo: delivery,
    withTransaction: (work) => work({ delivery, orders }),
    config: CONFIG,
  });
  return { svc, order, offers, deliveries, history };
}

const RIDER10: Actor = { ulid: 'rider10', roles: ['rider'] };
const RIDER11: Actor = { ulid: 'rider11', roles: ['rider'] };

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

describe('assignment service — offerNext', () => {
  it('offers a ready order to the nearest candidate', async () => {
    const w = makeWorld();
    const r = await w.svc.offerForOrder('ORD1');
    expect(r.offered).toBe(true);
    expect(r.riderId).toBe(10);
    expect(w.offers).toHaveLength(1);
  });

  it('does not offer an order that is not ready', async () => {
    const w = makeWorld();
    w.order.status = 'placed';
    expect((await w.svc.offerForOrder('ORD1')).reason).toBe('not_ready');
  });

  it('does not offer when a live offer already exists', async () => {
    const w = makeWorld();
    await w.svc.offerForOrder('ORD1');
    expect((await w.svc.offerForOrder('ORD1')).reason).toBe('offer_live');
  });

  it('reports no_candidates when nobody is eligible', async () => {
    const w = makeWorld({ candidates: [] });
    expect((await w.svc.offerForOrder('ORD1')).reason).toBe('no_candidates');
  });
});

describe('assignment service — acceptOffer', () => {
  it('assigns the rider: delivery created, order rider_assigned, fee snapshotted', async () => {
    const w = makeWorld();
    const offerId = (await w.svc.offerForOrder('ORD1')).offerId!;
    const view = await w.svc.acceptOffer(RIDER10, offerId);
    expect(view.status).toBe('rider_assigned');
    expect(view.riderFeeCents).toBe(7_000);
    expect(w.order.status).toBe('rider_assigned');
    expect(w.deliveries).toHaveLength(1);
    expect(w.history.at(-1)).toMatchObject({ toStatus: 'rider_assigned', actorType: 'rider' });
  });

  it('404s when the offer is not the caller’s', async () => {
    const w = makeWorld();
    const offerId = (await w.svc.offerForOrder('ORD1')).offerId!;
    expect(await thrownStatus(w.svc.acceptOffer(RIDER11, offerId))).toBe(404);
  });

  it('409 OFFER_EXPIRED on a lapsed offer', async () => {
    const w = makeWorld();
    const offerId = (await w.svc.offerForOrder('ORD1')).offerId!;
    w.offers[0]!.expiresAt = new Date(Date.now() - 1_000);
    expect(await thrownStatus(w.svc.acceptOffer(RIDER10, offerId))).toBe(409);
  });

  it('409 OFFER_ALREADY_TAKEN when the order is already assigned', async () => {
    const w = makeWorld();
    const offerId = (await w.svc.offerForOrder('ORD1')).offerId!;
    await w.svc.acceptOffer(RIDER10, offerId); // first win
    // A second offer on the same (now assigned) order cannot be accepted.
    w.offers.push({
      id: 99,
      orderId: w.order.id,
      orderUlid: 'ORD1',
      riderId: 11,
      status: 'offered',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await thrownStatus(w.svc.acceptOffer(RIDER11, 99))).toBe(409);
  });
});

describe('assignment service — decline re-offers the next candidate', () => {
  it('declines then offers the next-nearest rider', async () => {
    const w = makeWorld({
      candidates: [
        { userId: 10, lat: 0, lng: 0 },
        { userId: 11, lat: 0.001, lng: 0 },
      ],
    });
    const offerId = (await w.svc.offerForOrder('ORD1')).offerId!; // → rider 10
    const next = await w.svc.declineOffer(RIDER10, offerId);
    expect(next.offered).toBe(true);
    expect(next.riderId).toBe(11); // 10 already offered, so the next candidate
    expect(w.offers.find((o) => o.id === offerId)?.status).toBe('declined');
  });
});
