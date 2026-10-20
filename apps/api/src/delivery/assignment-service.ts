import { conflict, notFound, unauthorized } from '../http/errors';
import type { OrdersRepo } from '../orders/repo';
import { assertTransition } from '../orders/state-machine';
import { rankCandidates } from './candidate';
import type { DeliveryRepo, RiderOfferView } from './repo';
import { computeRiderFeeCents } from './rider-fee';

/** The acting principal (from req.principal). */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface OfferResult {
  offered: boolean;
  offerId?: number;
  riderId?: number;
  reason?: string;
}

export interface AcceptView {
  orderUlid: string;
  status: 'rider_assigned';
  deliveryId: number;
  riderFeeCents: number;
}

export interface TickResult {
  expired: number;
  scanned: number;
  offered: number;
}

/** The transaction-bound repos an assignment mutation needs. */
export interface AssignmentRepos {
  delivery: DeliveryRepo;
  orders: OrdersRepo;
}

export interface AssignmentConfig {
  maxRadiusM: number;
  offerTtlSec: number;
  presenceFreshnessSec: number;
  riderFeeFlatCents: number;
}

export interface AssignmentServiceDeps {
  readRepo: DeliveryRepo;
  withTransaction: <T>(work: (repos: AssignmentRepos) => Promise<T>) => Promise<T>;
  config: AssignmentConfig;
}

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ER_DUP_ENTRY'
  );
}

export function createAssignmentService(deps: AssignmentServiceDeps) {
  const { readRepo, withTransaction, config } = deps;

  /**
   * Offer the order to the best not-yet-offered candidate (doc 08 §2). Runs in a transaction: it
   * re-checks that the order is `ready_for_pickup` with no live offer, ranks online+fresh+in-range
   * riders by distance, and inserts one time-boxed offer. No candidates → the order simply waits
   * (ops can see it unoffered); never a dead state.
   */
  async function offerNextTx(delivery: DeliveryRepo, orderUlid: string): Promise<OfferResult> {
    const ctx = await delivery.getAssignmentContext(orderUlid);
    if (!ctx) {
      return { offered: false, reason: 'order_not_found' };
    }
    if (ctx.status !== 'ready_for_pickup') {
      return { offered: false, reason: 'not_ready' };
    }
    if (await delivery.findLiveOffer(ctx.orderId, new Date())) {
      return { offered: false, reason: 'offer_live' };
    }
    if (ctx.merchantLat === null || ctx.merchantLng === null) {
      return { offered: false, reason: 'merchant_no_location' };
    }
    const cutoff = new Date(Date.now() - config.presenceFreshnessSec * 1000);
    const candidates = await delivery.listCandidateRiders(cutoff);
    const alreadyOffered = new Set(await delivery.listOfferedRiderIds(ctx.orderId));
    const ranked = rankCandidates(
      candidates.filter((c) => !alreadyOffered.has(c.userId)),
      { lat: ctx.merchantLat, lng: ctx.merchantLng },
      config.maxRadiusM,
    );
    const chosen = ranked[0];
    if (chosen === undefined) {
      return { offered: false, reason: 'no_candidates' };
    }
    const expiresAt = new Date(Date.now() + config.offerTtlSec * 1000);
    const offerId = await delivery.insertOffer({
      orderId: ctx.orderId,
      riderId: chosen,
      expiresAt,
    });
    return { offered: true, offerId, riderId: chosen };
  }

  function offerForOrder(orderUlid: string): Promise<OfferResult> {
    return withTransaction(({ delivery }) => offerNextTx(delivery, orderUlid));
  }

  async function requireRiderUserId(orders: OrdersRepo, actor: Actor): Promise<number> {
    const userId = await orders.findUserIdByUlid(actor.ulid);
    if (userId === null) {
      throw unauthorized('Unknown principal');
    }
    return userId;
  }

  /**
   * Accept an offer (doc 08 §2.2) — the atomic, first-wins step. Locks the order row, then the
   * offer; verifies the offer is still open + unexpired and the order is still `ready_for_pickup`;
   * then creates the single delivery (UNIQUE `order_id` is the backstop), supersedes sibling
   * offers, and moves the order to `rider_assigned`. Concurrent accepts serialise on the order lock
   * → exactly one wins; the rest get 409 `OFFER_ALREADY_TAKEN`.
   */
  async function acceptOffer(actor: Actor, offerId: number): Promise<AcceptView> {
    return withTransaction(async ({ delivery, orders }) => {
      const riderUserId = await requireRiderUserId(orders, actor);
      const peek = await delivery.findOfferById(offerId);
      if (!peek || peek.riderId !== riderUserId) {
        throw notFound('Offer not found');
      }
      const order = await orders.lockOrderByUlid(peek.orderUlid); // primary lock (shared resource)
      if (!order) {
        throw notFound('Offer not found');
      }
      const offer = await delivery.lockOfferById(offerId);
      if (!offer || offer.status !== 'offered') {
        throw conflict('OFFER_NOT_OPEN', 'Offer is no longer open');
      }
      if (offer.expiresAt.getTime() <= Date.now()) {
        await delivery.markOfferStatus(offerId, 'expired', new Date());
        throw conflict('OFFER_EXPIRED', 'Offer has expired');
      }
      if (order.status !== 'ready_for_pickup' || (await delivery.findDeliveryByOrderId(order.id))) {
        throw conflict('OFFER_ALREADY_TAKEN', 'The order has already been assigned');
      }
      assertTransition(order.status, 'rider_assigned');

      const riderFeeCents = computeRiderFeeCents(order.deliveryFeeCents, config.riderFeeFlatCents);
      let deliveryId: number;
      try {
        deliveryId = await delivery.insertDelivery({
          orderId: order.id,
          riderId: riderUserId,
          status: 'assigned',
          riderFeeCents,
        });
      } catch (err) {
        if (isDuplicateKey(err)) {
          throw conflict('OFFER_ALREADY_TAKEN', 'The order has already been assigned');
        }
        throw err;
      }
      await delivery.markOfferStatus(offerId, 'accepted', new Date());
      await delivery.supersedeOtherOffers(order.id, offerId);
      await orders.setOrderStatus(order.id, 'rider_assigned', null);
      await orders.insertStatusHistory({
        orderId: order.id,
        fromStatus: 'ready_for_pickup',
        toStatus: 'rider_assigned',
        actorType: 'rider',
        actorUserId: riderUserId,
        reason: null,
      });
      return { orderUlid: order.ulid, status: 'rider_assigned', deliveryId, riderFeeCents };
    });
  }

  /** Decline an offer and immediately offer the next candidate. */
  async function declineOffer(actor: Actor, offerId: number): Promise<OfferResult> {
    return withTransaction(async ({ delivery, orders }) => {
      const riderUserId = await requireRiderUserId(orders, actor);
      const peek = await delivery.findOfferById(offerId);
      if (!peek || peek.riderId !== riderUserId) {
        throw notFound('Offer not found');
      }
      const offer = await delivery.lockOfferById(offerId);
      if (!offer || offer.status !== 'offered') {
        throw conflict('OFFER_NOT_OPEN', 'Offer is no longer open');
      }
      await delivery.markOfferStatus(offerId, 'declined', new Date());
      return offerNextTx(delivery, peek.orderUlid);
    });
  }

  /** List the caller's live (open, unexpired) offers. Read-only — expiry is driven by the tick. */
  async function listOffers(actor: Actor): Promise<RiderOfferView[]> {
    const riderUserId = await readRepo.findUserIdByUlid(actor.ulid);
    if (riderUserId === null) {
      throw unauthorized('Unknown principal');
    }
    return readRepo.listLiveOffersForRider(riderUserId, new Date());
  }

  /**
   * Admin/dev tick (no scheduler this phase): expire open offers past their deadline, then offer
   * every `ready_for_pickup` order that now has no live offer (initial offers + re-offers after an
   * expiry). Idempotent — safe to call repeatedly.
   */
  async function tick(): Promise<TickResult> {
    const now = new Date();
    const expired = await withTransaction(({ delivery }) => delivery.expireStaleOffers(now));
    const ready = await readRepo.listReadyOrdersForAssignment(now);
    let offered = 0;
    for (const orderUlid of ready) {
      const result = await offerForOrder(orderUlid);
      if (result.offered) {
        offered += 1;
      }
    }
    return { expired, scanned: ready.length, offered };
  }

  return { offerForOrder, acceptOffer, declineOffer, listOffers, tick };
}

export type AssignmentService = ReturnType<typeof createAssignmentService>;
