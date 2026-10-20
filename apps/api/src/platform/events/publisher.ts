import type { Logger } from '../logger';
import type { RealtimeResolver } from '../realtime/authorize';
import type { RealtimeGateway } from '../realtime/gateway';

/**
 * Domain → realtime bridge. Services call `orderStatusChanged` **after their transaction commits**
 * (best-effort; a missed emit is self-healing because clients re-fetch canonical state via REST).
 * The default is a no-op so services stay decoupled from transport (and tests stay quiet).
 */
export interface DomainEventPublisher {
  orderStatusChanged(orderUlid: string, toStatus: string): void;
}

export const noopPublisher: DomainEventPublisher = {
  orderStatusChanged() {},
};

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
  };
}
