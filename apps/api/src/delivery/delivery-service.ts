import type { AuditService } from '../auth/audit-service';
import { conflict, forbidden, notFound, unauthorized } from '../http/errors';
import type { LedgerRepo } from '../ledger/repo';
import type { LedgerService } from '../ledger/ledger-service';
import { noopPublisher, type DomainEventPublisher } from '../platform/events/publisher';
import type { OrdersRepo } from '../orders/repo';
import { assertTransition, type ActorType } from '../orders/state-machine';
import { buildRiderEarningsLines } from './earnings';
import { generatePin, hashPin, verifyPin } from './pin';
import type { DeliveryRepo, DeliveryWithOrder } from './repo';

/** The acting principal (from req.principal). */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface DeliveryView {
  orderUlid: string;
  orderStatus: string;
  deliveryStatus: string;
  riderFeeCents: number;
}

export interface DeliveryTxRepos {
  delivery: DeliveryRepo;
  orders: OrdersRepo;
  ledger: LedgerRepo;
}

export interface DeliveryServiceDeps {
  readRepo: DeliveryRepo;
  withTransaction: <T>(work: (repos: DeliveryTxRepos) => Promise<T>) => Promise<T>;
  ledgerService: LedgerService;
  auditService: AuditService;
  config: { pinTtlSec: number; pinMaxAttempts: number };
  /** Realtime publisher; emitted after commit (best-effort). Defaults to no-op. */
  events?: DomainEventPublisher;
}

function toView(dwo: DeliveryWithOrder, over: Partial<DeliveryView> = {}): DeliveryView {
  return {
    orderUlid: dwo.orderUlid,
    orderStatus: dwo.orderStatus,
    deliveryStatus: dwo.deliveryStatus,
    riderFeeCents: dwo.riderFeeCents,
    ...over,
  };
}

export function createDeliveryService(deps: DeliveryServiceDeps) {
  const {
    readRepo,
    withTransaction,
    ledgerService,
    auditService,
    config,
    events = noopPublisher,
  } = deps;

  async function requireUserId(repo: OrdersRepo, actor: Actor): Promise<number> {
    const userId = await repo.findUserIdByUlid(actor.ulid);
    if (userId === null) {
      throw unauthorized('Unknown principal');
    }
    return userId;
  }

  function isAdmin(actor: Actor): boolean {
    return actor.roles.includes('admin') || actor.roles.includes('ops');
  }

  /** Accrue the rider's snapshotted fee to `rider_payable` (idempotent; skipped when fee is 0). */
  async function postEarnings(
    ledger: LedgerRepo,
    deliveryId: number,
    riderId: number,
    riderFeeCents: number,
  ): Promise<void> {
    if (riderFeeCents <= 0) {
      return;
    }
    await ledgerService.post(ledger, {
      kind: 'rider_earning',
      refType: 'delivery',
      refId: deliveryId,
      idempotencyKey: `rider_earning:${deliveryId}`,
      lines: buildRiderEarningsLines(riderId, riderFeeCents),
    });
  }

  /** Rider confirms pickup at the merchant: order `rider_assigned → picked_up`. */
  async function confirmPickup(actor: Actor, orderUlid: string): Promise<DeliveryView> {
    const view = await withTransaction(async ({ delivery, orders }) => {
      const riderUserId = await requireUserId(orders, actor);
      const dwo = await delivery.lockDeliveryWithOrder(orderUlid);
      if (!dwo || dwo.riderId !== riderUserId) {
        throw notFound('Delivery not found');
      }
      assertTransition(dwo.orderStatus, 'picked_up');
      await delivery.setDeliveryPickedUp(dwo.deliveryId);
      await orders.setOrderStatus(dwo.orderId, 'picked_up', null);
      await orders.insertStatusHistory({
        orderId: dwo.orderId,
        fromStatus: dwo.orderStatus,
        toStatus: 'picked_up',
        actorType: 'rider',
        actorUserId: riderUserId,
        reason: null,
      });
      return toView(dwo, { orderStatus: 'picked_up', deliveryStatus: 'picked_up' });
    });
    events.orderStatusChanged(orderUlid, 'picked_up'); // after commit — best-effort
    return view;
  }

  /** Rider starts the trip: order `picked_up → out_for_delivery`. */
  async function startDelivery(actor: Actor, orderUlid: string): Promise<DeliveryView> {
    const view = await withTransaction(async ({ delivery, orders }) => {
      const riderUserId = await requireUserId(orders, actor);
      const dwo = await delivery.lockDeliveryWithOrder(orderUlid);
      if (!dwo || dwo.riderId !== riderUserId) {
        throw notFound('Delivery not found');
      }
      assertTransition(dwo.orderStatus, 'out_for_delivery');
      await orders.setOrderStatus(dwo.orderId, 'out_for_delivery', null);
      await orders.insertStatusHistory({
        orderId: dwo.orderId,
        fromStatus: dwo.orderStatus,
        toStatus: 'out_for_delivery',
        actorType: 'rider',
        actorUserId: riderUserId,
        reason: null,
      });
      return toView(dwo, { orderStatus: 'out_for_delivery' });
    });
    events.orderStatusChanged(orderUlid, 'out_for_delivery'); // after commit — best-effort
    return view;
  }

  /**
   * Customer issues/refreshes their proof-of-delivery PIN (doc 07 D7). Returns the plaintext once;
   * only the hash is stored. Re-issuing invalidates the previous code and resets attempts.
   */
  async function issueDeliveryPin(actor: Actor, orderUlid: string): Promise<{ pin: string }> {
    return withTransaction(async ({ delivery, orders }) => {
      const userId = await requireUserId(orders, actor);
      const dwo = await delivery.lockDeliveryWithOrder(orderUlid);
      if (!dwo || dwo.customerId !== userId) {
        throw notFound('Delivery not found');
      }
      if (dwo.orderStatus !== 'picked_up' && dwo.orderStatus !== 'out_for_delivery') {
        throw conflict(
          'PIN_NOT_AVAILABLE',
          'A delivery PIN is only available once the order is picked up',
        );
      }
      const pin = generatePin();
      await delivery.upsertDeliveryPin({
        deliveryId: dwo.deliveryId,
        pinHash: await hashPin(pin),
        expiresAt: new Date(Date.now() + config.pinTtlSec * 1000),
        maxAttempts: config.pinMaxAttempts,
      });
      return { pin };
    });
  }

  /** Rider completes the delivery by submitting the customer's PIN: `out_for_delivery → delivered`. */
  async function completeDelivery(
    actor: Actor,
    orderUlid: string,
    pin: string,
  ): Promise<DeliveryView> {
    const view = await withTransaction(async ({ delivery, orders, ledger }) => {
      const riderUserId = await requireUserId(orders, actor);
      const dwo = await delivery.lockDeliveryWithOrder(orderUlid);
      if (!dwo || dwo.riderId !== riderUserId) {
        throw notFound('Delivery not found');
      }
      assertTransition(dwo.orderStatus, 'delivered');

      const pinRow = await delivery.lockDeliveryPin(dwo.deliveryId);
      if (!pinRow || pinRow.consumedAt !== null) {
        throw conflict('NO_PIN_ISSUED', 'No delivery PIN has been issued for this order');
      }
      if (pinRow.expiresAt.getTime() <= Date.now()) {
        throw conflict('PIN_EXPIRED', 'The delivery PIN has expired; ask the customer to re-issue');
      }
      if (pinRow.attempts >= pinRow.maxAttempts) {
        throw conflict('PIN_LOCKED', 'Too many incorrect attempts; ask the customer to re-issue');
      }
      if (!(await verifyPin(pinRow.pinHash, pin))) {
        await delivery.incrementPinAttempts(dwo.deliveryId);
        throw conflict('PIN_INVALID', 'Incorrect delivery PIN');
      }

      await delivery.consumeDeliveryPin(dwo.deliveryId);
      await delivery.setDeliveryDelivered(dwo.deliveryId, 'pin', pinRow.pinHash);
      await finishDelivered(ledger, orders, dwo, 'rider', riderUserId);
      return toView(dwo, { orderStatus: 'delivered', deliveryStatus: 'delivered' });
    });
    events.orderStatusChanged(orderUlid, 'delivered'); // after commit — best-effort
    return view;
  }

  /** Admin override for a legitimate PIN failure (audited): complete without a PIN (doc 07 D7). */
  async function completeDeliveryOverride(
    actor: Actor,
    orderUlid: string,
    reason: string,
  ): Promise<DeliveryView> {
    if (!isAdmin(actor)) {
      throw forbidden();
    }
    const view = await withTransaction(async ({ delivery, orders, ledger }) => {
      const adminUserId = await orders.findUserIdByUlid(actor.ulid);
      const dwo = await delivery.lockDeliveryWithOrder(orderUlid);
      if (!dwo) {
        throw notFound('Delivery not found');
      }
      assertTransition(dwo.orderStatus, 'delivered');
      await delivery.setDeliveryDelivered(dwo.deliveryId, 'none', null);
      await finishDelivered(ledger, orders, dwo, 'admin', adminUserId);
      await auditService.record({
        actorUserId: adminUserId,
        actorRole: 'admin',
        action: 'delivery.pin_override',
        entityType: 'delivery',
        entityId: dwo.deliveryId,
        before: { orderStatus: dwo.orderStatus },
        after: { orderStatus: 'delivered', reason },
      });
      return toView(dwo, { orderStatus: 'delivered', deliveryStatus: 'delivered' });
    });
    events.orderStatusChanged(orderUlid, 'delivered'); // after commit — best-effort
    return view;
  }

  /** Shared tail: move the order to `delivered`, record history, accrue rider earnings. */
  async function finishDelivered(
    ledger: LedgerRepo,
    orders: OrdersRepo,
    dwo: DeliveryWithOrder,
    actorType: ActorType,
    actorUserId: number | null,
  ): Promise<void> {
    await orders.setOrderStatus(dwo.orderId, 'delivered', null);
    await orders.insertStatusHistory({
      orderId: dwo.orderId,
      fromStatus: dwo.orderStatus,
      toStatus: 'delivered',
      actorType,
      actorUserId,
      reason: null,
    });
    if (dwo.riderId !== null) {
      await postEarnings(ledger, dwo.deliveryId, dwo.riderId, dwo.riderFeeCents);
    }
  }

  async function getDelivery(actor: Actor, orderUlid: string): Promise<DeliveryView> {
    const userId = await readRepo.findUserIdByUlid(actor.ulid);
    const dwo = await readRepo.findDeliveryWithOrder(orderUlid);
    if (!dwo || (!isAdmin(actor) && dwo.riderId !== userId && dwo.customerId !== userId)) {
      throw notFound('Delivery not found');
    }
    return toView(dwo);
  }

  return {
    confirmPickup,
    startDelivery,
    issueDeliveryPin,
    completeDelivery,
    completeDeliveryOverride,
    getDelivery,
  };
}

export type DeliveryService = ReturnType<typeof createDeliveryService>;
