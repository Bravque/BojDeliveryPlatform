import { forbidden, notFound } from '../http/errors';
import { noopPublisher, type DomainEventPublisher } from '../platform/events/publisher';
import type { OrderRecord, OrdersRepo } from './repo';
import { assertTransition, type ActorType, type OrderStatus } from './state-machine';

/** The acting principal (from req.principal). */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface FulfillmentView {
  ulid: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
}

export interface FulfillmentServiceDeps {
  withTransaction: <T>(work: (repo: OrdersRepo) => Promise<T>) => Promise<T>;
  /**
   * Optional hook fired (after commit) when an order reaches `ready_for_pickup`, so rider
   * assignment can offer it. Decoupled via a callback so the orders module needn't import the
   * delivery module; a failure here is swallowed (the order is ready — a tick re-offers).
   */
  onReadyForPickup?: (orderUlid: string) => Promise<void>;
  /** Realtime publisher; emitted after commit (best-effort). Defaults to no-op. */
  events?: DomainEventPublisher;
}

function toView(order: OrderRecord): FulfillmentView {
  return {
    ulid: order.ulid,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
  };
}

/**
 * Merchant-driven order progression (doc 04): the merchant accepts/rejects a `placed` order and
 * walks it through preparation to `ready_for_pickup` (the trigger point for rider assignment in
 * increment 4). Each step locks the order row, validates the transition via the state machine, and
 * appends to `order_status_history` in one transaction. A merchant actor may only act on their own
 * merchant's orders; admins/ops may act on any. **Rejecting only sets `rejected`** — money movement
 * (refunding a captured order) stays with the existing refund flow.
 */
export function createFulfillmentService(deps: FulfillmentServiceDeps) {
  const { withTransaction, onReadyForPickup, events = noopPublisher } = deps;

  function isAdmin(actor: Actor): boolean {
    return actor.roles.includes('admin') || actor.roles.includes('ops');
  }

  async function assertMerchantAccess(
    repo: OrdersRepo,
    actor: Actor,
    merchantId: number,
  ): Promise<void> {
    if (isAdmin(actor)) {
      return;
    }
    const staff = await repo.findMerchantStaffUlids(merchantId);
    if (!staff.includes(actor.ulid)) {
      throw forbidden('Not a member of this merchant');
    }
  }

  async function advance(
    actor: Actor,
    orderUlid: string,
    to: OrderStatus,
    reason: string | null = null,
  ): Promise<FulfillmentView> {
    const view = await withTransaction(async (repo) => {
      const order = await repo.lockOrderByUlid(orderUlid);
      if (!order) {
        throw notFound('Order not found');
      }
      await assertMerchantAccess(repo, actor, order.merchantId);
      const fromStatus = order.status;
      assertTransition(fromStatus, to);

      await repo.setOrderStatus(order.id, to, reason);
      const actorType: ActorType = isAdmin(actor) ? 'admin' : 'merchant';
      await repo.insertStatusHistory({
        orderId: order.id,
        fromStatus,
        toStatus: to,
        actorType,
        actorUserId: await repo.findUserIdByUlid(actor.ulid),
        reason,
      });
      return toView({ ...order, status: to });
    });
    events.orderStatusChanged(orderUlid, to); // after commit — best-effort
    return view;
  }

  function acceptOrder(actor: Actor, orderUlid: string): Promise<FulfillmentView> {
    return advance(actor, orderUlid, 'merchant_accepted');
  }

  function startPreparing(actor: Actor, orderUlid: string): Promise<FulfillmentView> {
    return advance(actor, orderUlid, 'preparing');
  }

  async function markReadyForPickup(actor: Actor, orderUlid: string): Promise<FulfillmentView> {
    const view = await advance(actor, orderUlid, 'ready_for_pickup');
    // Kick rider assignment once the transition is committed (best-effort; a tick recovers).
    if (onReadyForPickup) {
      try {
        await onReadyForPickup(orderUlid);
      } catch {
        // Swallow — the order is ready; the assignment tick will re-offer.
      }
    }
    return view;
  }

  function rejectOrder(actor: Actor, orderUlid: string, reason: string): Promise<FulfillmentView> {
    return advance(actor, orderUlid, 'rejected', reason);
  }

  return { acceptOrder, startPreparing, markReadyForPickup, rejectOrder };
}

export type FulfillmentService = ReturnType<typeof createFulfillmentService>;
