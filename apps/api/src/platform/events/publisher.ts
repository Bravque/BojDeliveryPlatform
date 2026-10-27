import type { Logger } from '../logger';
import type { RealtimeResolver } from '../realtime/authorize';
import type { RealtimeGateway } from '../realtime/gateway';

/**
 * Domain → realtime bridge. Services call `orderStatusChanged` **after their transaction commits**
 * (best-effort; a missed emit is self-healing because clients re-fetch canonical state via REST).
 * The default is a no-op so services stay decoupled from transport (and tests stay quiet).
 */
/** A rider-offer hint pushed to a rider's room — references only; the client re-fetches offers. */
export interface RiderOfferNotice {
  offerId: number;
  orderUlid: string;
  expiresAt: string;
}

export interface DomainEventPublisher {
  orderStatusChanged(orderUlid: string, toStatus: string): void;
  /** A time-boxed offer was made to a rider (initial offer, re-offer, or after a decline). */
  riderOffered(riderUlid: string, offer: RiderOfferNotice): void;
}

export const noopPublisher: DomainEventPublisher = {
  orderStatusChanged() {},
  riderOffered() {},
};

/** Fan a domain event out to several publishers (e.g. realtime + notifications). */
export function combinePublishers(...publishers: DomainEventPublisher[]): DomainEventPublisher {
  return {
    orderStatusChanged(orderUlid, toStatus) {
      for (const p of publishers) {
        p.orderStatusChanged(orderUlid, toStatus);
      }
    },
    riderOffered(riderUlid, offer) {
      for (const p of publishers) {
        p.riderOffered(riderUlid, offer);
      }
    },
  };
}

export interface RealtimeEventPublisherDeps {
  gateway: RealtimeGateway;
  resolver: Pick<RealtimeResolver, 'orderParticipants'>;
  logger: Logger;
}

/**
 * Fan an order status change out to the realtime rooms: `status.changed` to `order:{ulid}` (for the
 * customer / assigned rider / merchant staff watching the order) and `order.new` (on `placed`) or
 * `order.updated` to that order's `merchant:{ulid}` room. Payloads are hints only — `{ orderUlid,
 * status }` — never money or authoritative state.
 */
export function createRealtimeEventPublisher(
  deps: RealtimeEventPublisherDeps,
): DomainEventPublisher {
  const { gateway, resolver, logger } = deps;
  return {
    orderStatusChanged(orderUlid, toStatus) {
      const payload = { orderUlid, status: toStatus };
      gateway.emitOrder(orderUlid, 'status.changed', payload);
      resolver
        .orderParticipants(orderUlid)
        .then((participants) => {
          if (participants) {
            const event = toStatus === 'placed' ? 'order.new' : 'order.updated';
            gateway.emitMerchant(participants.merchantUlid, event, payload);
          }
        })
        .catch((err: unknown) => logger.warn({ err, orderUlid }, 'realtime merchant emit failed'));
    },

    riderOffered(riderUlid, offer) {
      gateway.emitRider(riderUlid, 'offer.new', offer);
    },
  };
}
