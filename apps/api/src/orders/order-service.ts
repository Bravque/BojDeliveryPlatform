import { applyBps } from '@boj/money';
import { conflict, notFound, unauthorized, unprocessable } from '../http/errors';
import { distanceMeters } from '../fees/compute';
import { priceLine, sumSubtotalCents } from '../pricing/compute';
import type { FeeResolver, ZoneResolver } from '../pricing/quote-service';
import { evaluatePromotion, type PromotionRecord } from '../promotions/promotion';
import { newUlid } from '../auth/crypto';
import { generateOrderNumber } from './order-number';
import type { OrderRecord, OrdersRepo } from './repo';
import { assertTransition, type ActorType } from './state-machine';

/** The acting principal (from req.principal). */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface CreateOrderInput {
  addressUlid: string;
  promoCode?: string;
}

export interface OrderItemView {
  productUlid: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
  options: Array<{ name: string; priceDeltaCents: number }>;
}

export interface OrderView {
  ulid: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  merchant: { ulid: string; name: string };
  currency: string;
  items: OrderItemView[];
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  discountCents: number;
  totalCents: number;
  commissionBps: number;
  commissionCents: number;
  distanceM: number | null;
  cancelledReason: string | null;
  createdAt: string;
}

export interface OrderSummary {
  ulid: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  totalCents: number;
  currency: string;
  createdAt: string;
}

export interface OrderServiceDeps {
  readRepo: OrdersRepo;
  withTransaction: <T>(work: (repo: OrdersRepo) => Promise<T>) => Promise<T>;
  zones: ZoneResolver;
  fees: FeeResolver;
}

const SERVICE_FEE_CENTS = 0;

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function createOrderService(deps: OrderServiceDeps) {
  const { readRepo, withTransaction, zones, fees } = deps;

  function isAdmin(actor: Actor): boolean {
    return actor.roles.includes('admin') || actor.roles.includes('ops');
  }

  async function requireUserId(repo: OrdersRepo, actor: Actor): Promise<number> {
    const userId = await repo.findUserIdByUlid(actor.ulid);
    if (userId === null) {
      throw unauthorized('Unknown principal');
    }
    return userId;
  }

  async function assemble(repo: OrdersRepo, order: OrderRecord): Promise<OrderView> {
    const items = await repo.getOrderItems(order.id);
    const options = await repo.getOrderItemOptions(items.map((i) => i.id));
    const optionsByItem = new Map<number, Array<{ name: string; priceDeltaCents: number }>>();
    for (const opt of options) {
      const list = optionsByItem.get(opt.orderItemId) ?? [];
      list.push({ name: opt.nameSnapshot, priceDeltaCents: opt.priceDeltaCents });
      optionsByItem.set(opt.orderItemId, list);
    }
    const merchant = await repo.getMerchant(order.merchantId);
    return {
      ulid: order.ulid,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      merchant: { ulid: merchant?.ulid ?? '', name: merchant?.name ?? '' },
      currency: order.currency,
      items: items.map((i) => ({
        productUlid: i.productUlid,
        name: i.nameSnapshot,
        unitPriceCents: i.unitPriceCents,
        quantity: i.quantity,
        lineTotalCents: i.lineTotalCents,
        options: optionsByItem.get(i.id) ?? [],
      })),
      subtotalCents: order.subtotalCents,
      deliveryFeeCents: order.deliveryFeeCents,
      serviceFeeCents: order.serviceFeeCents,
      discountCents: order.discountCents,
      totalCents: order.totalCents,
      commissionBps: order.commissionBps,
      commissionCents: order.commissionCents,
      distanceM: order.distanceM,
      cancelledReason: order.cancelledReason,
      createdAt: order.createdAt.toISOString(),
    };
  }

  async function createOrder(actor: Actor, input: CreateOrderInput): Promise<OrderView> {
    return withTransaction(async (repo) => {
      const userId = await requireUserId(repo, actor);

      const cart = await repo.findCart(userId);
      if (!cart || cart.merchantId === null) {
        throw unprocessable('CART_EMPTY', 'Cart is empty');
      }
      const items = await repo.listCartItems(cart.id);
      if (items.length === 0) {
        throw unprocessable('CART_EMPTY', 'Cart is empty');
      }

      const address = await repo.findAddressForUser(input.addressUlid, userId);
      if (!address) {
        throw notFound('Address not found');
      }
      const merchant = await repo.getMerchant(cart.merchantId);
      if (!merchant || merchant.status !== 'approved') {
        throw unprocessable('MERCHANT_UNAVAILABLE', 'Merchant is not available');
      }

      // Re-price from the catalogue (never the cart).
      const products = new Map(
        (await repo.getProducts([...new Set(items.map((i) => i.productId))])).map((p) => [p.id, p]),
      );
      const options = new Map(
        (await repo.getOptions([...new Set(items.flatMap((i) => i.optionUlids))])).map((o) => [
          o.ulid,
          o,
        ]),
      );
      const lines = items.map((item) => {
        const product = products.get(item.productId);
        if (!product) {
          throw unprocessable('ITEM_UNAVAILABLE', 'A product in the cart is no longer available');
        }
        const selected = item.optionUlids.map((ulid) => {
          const option = options.get(ulid);
          if (!option) {
            throw unprocessable('ITEM_UNAVAILABLE', 'A selected option is no longer available');
          }
          return option;
        });
        return priceLine(product, item.quantity, selected);
      });
      const subtotalCents = sumSubtotalCents(lines);

      const zone = await zones.resolveZone(address.lat, address.lng);
      if (!zone) {
        throw unprocessable('OUT_OF_ZONE', 'This address is outside our delivery area');
      }
      const distanceM =
        merchant.lat !== null && merchant.lng !== null
          ? distanceMeters(
              { lat: merchant.lat, lng: merchant.lng },
              { lat: address.lat, lng: address.lng },
            )
          : 0;
      const feeQuote = await fees.resolveFee(zone.id, distanceM);
      if (!feeQuote) {
        throw unprocessable('DELIVERY_FEE_UNAVAILABLE', 'Delivery is not priced for this area');
      }
      const deliveryFeeCents = feeQuote.feeCents;
      const serviceFeeCents = SERVICE_FEE_CENTS;

      // Promotion (per-user limit enforced here with the redemption table).
      let discountCents = 0;
      let promotion: PromotionRecord | null = null;
      if (input.promoCode) {
        promotion = await repo.findPromotionByCode(normalizeCode(input.promoCode));
        if (!promotion) {
          throw unprocessable('PROMO_NOT_FOUND', 'Promotion code not found');
        }
        const prior = await repo.countUserRedemptions(promotion.id, userId);
        discountCents = evaluatePromotion(
          promotion,
          { subtotalCents, deliveryFeeCents, serviceFeeCents, at: new Date() },
          prior,
        );
      }
      const totalCents = Math.max(
        0,
        subtotalCents + deliveryFeeCents + serviceFeeCents - discountCents,
      );
      const commissionBps = merchant.commissionBps;
      const commissionCents = applyBps(subtotalCents, commissionBps);

      // Reserve stock atomically; any shortfall rolls the whole checkout back.
      for (const item of items) {
        const ok = await repo.reserve(item.productId, item.quantity);
        if (!ok) {
          throw conflict('OUT_OF_STOCK', 'Insufficient stock for an item in your cart');
        }
      }

      const ulid = newUlid();
      const orderId = await repo.insertOrder({
        ulid,
        orderNumber: generateOrderNumber(),
        customerId: userId,
        merchantId: merchant.id,
        townId: merchant.townId,
        zoneId: zone.id,
        deliveryAddressId: address.id,
        status: 'draft',
        subtotalCents,
        deliveryFeeCents,
        serviceFeeCents,
        discountCents,
        totalCents,
        commissionBps,
        commissionCents,
        distanceM,
      });

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        const item = items[i]!;
        const orderItemId = await repo.insertOrderItem({
          orderId,
          productId: item.productId,
          nameSnapshot: line.name,
          unitPriceCents: line.unitPriceCents,
          quantity: line.quantity,
          lineTotalCents: line.lineTotalCents,
        });
        for (const opt of line.options) {
          await repo.insertOrderItemOption({
            orderItemId,
            nameSnapshot: opt.name,
            priceDeltaCents: opt.priceDeltaCents,
          });
        }
      }

      await repo.insertStatusHistory({
        orderId,
        fromStatus: null,
        toStatus: 'draft',
        actorType: 'customer',
        actorUserId: userId,
        reason: null,
      });

      if (promotion) {
        const ok = await repo.incrementPromotionRedeemed(promotion.id);
        if (!ok) {
          throw unprocessable('PROMO_EXHAUSTED', 'Promotion has been fully redeemed');
        }
        await repo.insertPromotionRedemption({
          promotionId: promotion.id,
          userId,
          orderId,
          discountCents,
        });
      }

      await repo.clearCart(cart.id);

      const created = await repo.findOrderByUlid(ulid);
      if (!created) {
        throw new Error('Order vanished after creation');
      }
      return assemble(repo, created);
    });
  }

  async function cancelOrder(actor: Actor, orderUlid: string, reason?: string): Promise<OrderView> {
    return withTransaction(async (repo) => {
      const userId = await requireUserId(repo, actor);
      const order = await repo.findOrderByUlid(orderUlid);
      if (!order || (!isAdmin(actor) && order.customerId !== userId)) {
        throw notFound('Order not found');
      }
      const fromStatus = order.status;
      assertTransition(fromStatus, 'cancelled');

      // Release reserved stock and reverse any promotion redemption.
      for (const line of await repo.listOrderStockLines(order.id)) {
        await repo.release(line.productId, line.quantity);
      }
      const redemption = await repo.getRedemptionByOrder(order.id);
      if (redemption) {
        await repo.decrementPromotionRedeemed(redemption.promotionId);
        await repo.deletePromotionRedemptionByOrder(order.id);
      }

      await repo.setOrderStatus(order.id, 'cancelled', reason ?? null);
      const actorType: ActorType = isAdmin(actor) ? 'admin' : 'customer';
      await repo.insertStatusHistory({
        orderId: order.id,
        fromStatus,
        toStatus: 'cancelled',
        actorType,
        actorUserId: userId,
        reason: reason ?? null,
      });

      const updated = await repo.findOrderByUlid(orderUlid);
      return assemble(repo, updated ?? order);
    });
  }

  async function getOrder(actor: Actor, orderUlid: string): Promise<OrderView> {
    const userId = await requireUserId(readRepo, actor);
    const order = await readRepo.findOrderByUlid(orderUlid);
    if (!order || (!isAdmin(actor) && order.customerId !== userId)) {
      throw notFound('Order not found');
    }
    return assemble(readRepo, order);
  }

  async function listOrders(actor: Actor): Promise<OrderSummary[]> {
    const userId = await requireUserId(readRepo, actor);
    const orders = await readRepo.listOrdersForUser(userId);
    return orders.map((o) => ({
      ulid: o.ulid,
      orderNumber: o.orderNumber,
      status: o.status,
      paymentStatus: o.paymentStatus,
      totalCents: o.totalCents,
      currency: o.currency,
      createdAt: o.createdAt.toISOString(),
    }));
  }

  return { createOrder, cancelOrder, getOrder, listOrders };
}

export type OrderService = ReturnType<typeof createOrderService>;
