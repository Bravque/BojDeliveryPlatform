import type { Knex } from 'knex';
import type { PromotionRecord, PromotionType } from '../promotions/promotion';
import type { ActorType, OrderStatus } from './state-machine';

/**
 * Persistence for orders. Every method runs against the `Knex` executor passed to the factory, so
 * the same repo code serves both a plain connection (reads) and a transaction (checkout/cancel):
 * the service builds a transaction-bound repo for the atomic create/cancel paths.
 */

export interface OrderCartRef {
  id: number;
  merchantId: number | null;
}

export interface OrderCartItem {
  productId: number;
  quantity: number;
  optionUlids: string[];
}

export interface OrderAddress {
  id: number;
  lat: number;
  lng: number;
}

export interface OrderMerchant {
  id: number;
  ulid: string;
  name: string;
  townId: number;
  status: string;
  commissionBps: number;
  lat: number | null;
  lng: number | null;
}

export interface OrderProduct {
  id: number;
  ulid: string;
  name: string;
  priceCents: number;
  isAvailable: boolean;
}

export interface OrderOption {
  ulid: string;
  name: string;
  priceDeltaCents: number;
  isAvailable: boolean;
}

export interface InsertOrderInput {
  ulid: string;
  orderNumber: string;
  customerId: number;
  merchantId: number;
  townId: number;
  zoneId: number;
  deliveryAddressId: number;
  status: OrderStatus;
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  discountCents: number;
  totalCents: number;
  commissionBps: number;
  commissionCents: number;
  distanceM: number;
}

export interface InsertOrderItemInput {
  orderId: number;
  productId: number;
  nameSnapshot: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface InsertStatusHistoryInput {
  orderId: number;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorType: ActorType;
  actorUserId: number | null;
  reason: string | null;
}

export interface OrderRecord {
  id: number;
  ulid: string;
  orderNumber: string;
  customerId: number;
  merchantId: number;
  status: OrderStatus;
  paymentStatus: string;
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  discountCents: number;
  totalCents: number;
  commissionBps: number;
  commissionCents: number;
  currency: string;
  distanceM: number | null;
  cancelledReason: string | null;
  createdAt: Date;
}

export interface OrderItemRecord {
  id: number;
  productUlid: string;
  nameSnapshot: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface OrderItemOptionRecord {
  orderItemId: number;
  nameSnapshot: string;
  priceDeltaCents: number;
}

export interface OrdersRepo {
  findUserIdByUlid(ulid: string): Promise<number | null>;
  findCart(userId: number): Promise<OrderCartRef | null>;
  listCartItems(cartId: number): Promise<OrderCartItem[]>;
  findAddressForUser(addressUlid: string, userId: number): Promise<OrderAddress | null>;
  getMerchant(merchantId: number): Promise<OrderMerchant | null>;
  getProducts(ids: number[]): Promise<OrderProduct[]>;
  getOptions(ulids: string[]): Promise<OrderOption[]>;
  findPromotionByCode(code: string): Promise<PromotionRecord | null>;
  countUserRedemptions(promotionId: number, userId: number): Promise<number>;

  reserve(productId: number, quantity: number): Promise<boolean>;
  release(productId: number, quantity: number): Promise<void>;
  incrementPromotionRedeemed(promotionId: number): Promise<boolean>;
  decrementPromotionRedeemed(promotionId: number): Promise<void>;
  insertPromotionRedemption(input: {
    promotionId: number;
    userId: number;
    orderId: number;
    discountCents: number;
  }): Promise<void>;
  getRedemptionByOrder(orderId: number): Promise<{ promotionId: number } | null>;
  deletePromotionRedemptionByOrder(orderId: number): Promise<void>;

  insertOrder(input: InsertOrderInput): Promise<number>;
  insertOrderItem(input: InsertOrderItemInput): Promise<number>;
  insertOrderItemOption(input: {
    orderItemId: number;
    nameSnapshot: string;
    priceDeltaCents: number;
  }): Promise<void>;
  insertStatusHistory(input: InsertStatusHistoryInput): Promise<void>;
  setOrderStatus(
    orderId: number,
    status: OrderStatus,
    cancelledReason: string | null,
  ): Promise<void>;
  clearCart(cartId: number): Promise<void>;

  findOrderByUlid(ulid: string): Promise<OrderRecord | null>;
  /** Load an order inside a transaction, locking the row (FOR UPDATE) — merchant/rider progression. */
  lockOrderByUlid(ulid: string): Promise<OrderRecord | null>;
  /** User ulids linked to a merchant (owner + staff), for the merchant-ownership gate. */
  findMerchantStaffUlids(merchantId: number): Promise<string[]>;
  /** The merchant a staff user belongs to (first match), for the merchant dashboard. */
  findMerchantForStaff(
    userUlid: string,
  ): Promise<{ id: number; ulid: string; name: string } | null>;
  /** All orders for a merchant, newest first (merchant dashboard list). */
  listMerchantOrders(merchantId: number): Promise<OrderRecord[]>;
  listOrdersForUser(userId: number): Promise<OrderRecord[]>;
  /** Product id + quantity per line, for releasing reserved stock on cancellation. */
  listOrderStockLines(orderId: number): Promise<Array<{ productId: number; quantity: number }>>;
  getOrderItems(orderId: number): Promise<OrderItemRecord[]>;
  getOrderItemOptions(orderItemIds: number[]): Promise<OrderItemOptionRecord[]>;
}

function parseOptionUlids(value: string | string[] | null): string[] {
  if (value === null) {
    return [];
  }
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

interface PromotionRowDb {
  id: number | string;
  ulid: string;
  code: string;
  type: PromotionType;
  value_bps: number | string | null;
  value_cents: number | string | null;
  max_discount_cents: number | string | null;
  min_subtotal_cents: number | string;
  per_user_limit: number | string;
  total_limit: number | string | null;
  total_redeemed: number | string;
  starts_at: string | Date;
  ends_at: string | Date;
  is_active: number | boolean;
}

function mapPromotion(row: PromotionRowDb): PromotionRecord {
  const n = (v: number | string | null): number | null => (v === null ? null : Number(v));
  return {
    id: Number(row.id),
    ulid: row.ulid,
    code: row.code,
    type: row.type,
    valueBps: n(row.value_bps),
    valueCents: n(row.value_cents),
    maxDiscountCents: n(row.max_discount_cents),
    minSubtotalCents: Number(row.min_subtotal_cents),
    perUserLimit: Number(row.per_user_limit),
    totalLimit: n(row.total_limit),
    totalRedeemed: Number(row.total_redeemed),
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    isActive: Boolean(row.is_active),
  };
}

interface OrderRowDb {
  id: number | string;
  ulid: string;
  order_number: string;
  customer_id: number | string;
  merchant_id: number | string;
  status: OrderStatus;
  payment_status: string;
  subtotal_cents: number | string;
  delivery_fee_cents: number | string;
  service_fee_cents: number | string;
  discount_cents: number | string;
  total_cents: number | string;
  commission_bps: number | string;
  commission_cents: number | string;
  currency: string;
  distance_m: number | string | null;
  cancelled_reason: string | null;
  created_at: string | Date;
}

function mapOrder(row: OrderRowDb): OrderRecord {
  return {
    id: Number(row.id),
    ulid: row.ulid,
    orderNumber: row.order_number,
    customerId: Number(row.customer_id),
    merchantId: Number(row.merchant_id),
    status: row.status,
    paymentStatus: row.payment_status,
    subtotalCents: Number(row.subtotal_cents),
    deliveryFeeCents: Number(row.delivery_fee_cents),
    serviceFeeCents: Number(row.service_fee_cents),
    discountCents: Number(row.discount_cents),
    totalCents: Number(row.total_cents),
    commissionBps: Number(row.commission_bps),
    commissionCents: Number(row.commission_cents),
    currency: row.currency,
    distanceM: row.distance_m === null ? null : Number(row.distance_m),
    cancelledReason: row.cancelled_reason,
    createdAt: new Date(row.created_at),
  };
}

export function createKnexOrdersRepo(exec: Knex): OrdersRepo {
  return {
    async findUserIdByUlid(ulid) {
      const row = (await exec('user').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async findCart(userId) {
      const row = (await exec('cart').where({ user_id: userId }).first('id', 'merchant_id')) as
        { id: number | string; merchant_id: number | string | null } | undefined;
      if (!row) {
        return null;
      }
      return {
        id: Number(row.id),
        merchantId: row.merchant_id === null ? null : Number(row.merchant_id),
      };
    },

    async listCartItems(cartId) {
      const rows = (await exec('cart_item')
        .where({ cart_id: cartId })
        .orderBy('id', 'asc')
        .select('product_id', 'quantity', 'options_json')) as Array<{
        product_id: number | string;
        quantity: number | string;
        options_json: string | string[] | null;
      }>;
      return rows.map((r) => ({
        productId: Number(r.product_id),
        quantity: Number(r.quantity),
        optionUlids: parseOptionUlids(r.options_json),
      }));
    },

    async findAddressForUser(addressUlid, userId) {
      const row = (await exec('address')
        .where({ ulid: addressUlid, user_id: userId })
        .first('id', 'lat', 'lng')) as
        { id: number | string; lat: string | number; lng: string | number } | undefined;
      return row ? { id: Number(row.id), lat: Number(row.lat), lng: Number(row.lng) } : null;
    },

    async getMerchant(merchantId) {
      const row = (await exec('merchant')
        .where({ id: merchantId })
        .first('id', 'ulid', 'name', 'town_id', 'status', 'commission_bps', 'lat', 'lng')) as
        | {
            id: number | string;
            ulid: string;
            name: string;
            town_id: number | string;
            status: string;
            commission_bps: number | string;
            lat: string | number | null;
            lng: string | number | null;
          }
        | undefined;
      if (!row) {
        return null;
      }
      return {
        id: Number(row.id),
        ulid: row.ulid,
        name: row.name,
        townId: Number(row.town_id),
        status: row.status,
        commissionBps: Number(row.commission_bps),
        lat: row.lat === null ? null : Number(row.lat),
        lng: row.lng === null ? null : Number(row.lng),
      };
    },

    async getProducts(ids) {
      if (ids.length === 0) {
        return [];
      }
      const rows = (await exec('product')
        .whereIn('id', ids)
        .select('id', 'ulid', 'name', 'price_cents', 'is_available')) as Array<{
        id: number | string;
        ulid: string;
        name: string;
        price_cents: number | string;
        is_available: number | boolean;
      }>;
      return rows.map((r) => ({
        id: Number(r.id),
        ulid: r.ulid,
        name: r.name,
        priceCents: Number(r.price_cents),
        isAvailable: Boolean(r.is_available),
      }));
    },

    async getOptions(ulids) {
      if (ulids.length === 0) {
        return [];
      }
      const rows = (await exec('product_option')
        .whereIn('ulid', ulids)
        .select('ulid', 'name', 'price_delta_cents', 'is_available')) as Array<{
        ulid: string;
        name: string;
        price_delta_cents: number | string;
        is_available: number | boolean;
      }>;
      return rows.map((r) => ({
        ulid: r.ulid,
        name: r.name,
        priceDeltaCents: Number(r.price_delta_cents),
        isAvailable: Boolean(r.is_available),
      }));
    },

    async findPromotionByCode(code) {
      const row = (await exec('promotion').where({ code }).first()) as PromotionRowDb | undefined;
      return row ? mapPromotion(row) : null;
    },

    async countUserRedemptions(promotionId, userId) {
      const row = (await exec('promotion_redemption')
        .where({ promotion_id: promotionId, user_id: userId })
        .count<{ c: number | string }>({ c: '*' })
        .first()) as { c: number | string } | undefined;
      return row ? Number(row.c) : 0;
    },

    async reserve(productId, quantity) {
      const affected = await exec('inventory')
        .where('product_id', productId)
        .where('track_stock', true)
        .whereRaw('quantity - reserved >= ?', [quantity])
        .update({ reserved: exec.raw('reserved + ?', [quantity]) });
      if (affected > 0) {
        return true;
      }
      const row = (await exec('inventory').where('product_id', productId).first('track_stock')) as
        { track_stock: number | boolean } | undefined;
      return !row || !row.track_stock;
    },

    async release(productId, quantity) {
      await exec('inventory')
        .where('product_id', productId)
        .where('track_stock', true)
        .update({ reserved: exec.raw('GREATEST(reserved - ?, 0)', [quantity]) });
    },

    async incrementPromotionRedeemed(promotionId) {
      const affected = await exec('promotion')
        .where('id', promotionId)
        .where((b) => b.whereNull('total_limit').orWhereRaw('total_redeemed < total_limit'))
        .update({ total_redeemed: exec.raw('total_redeemed + 1') });
      return affected > 0;
    },

    async decrementPromotionRedeemed(promotionId) {
      await exec('promotion')
        .where('id', promotionId)
        .update({ total_redeemed: exec.raw('GREATEST(total_redeemed - 1, 0)') });
    },

    async insertPromotionRedemption(input) {
      await exec('promotion_redemption').insert({
        promotion_id: input.promotionId,
        user_id: input.userId,
        order_id: input.orderId,
        discount_cents: input.discountCents,
      });
    },

    async getRedemptionByOrder(orderId) {
      const row = (await exec('promotion_redemption')
        .where({ order_id: orderId })
        .first('promotion_id')) as { promotion_id: number | string } | undefined;
      return row ? { promotionId: Number(row.promotion_id) } : null;
    },

    async deletePromotionRedemptionByOrder(orderId) {
      await exec('promotion_redemption').where({ order_id: orderId }).del();
    },

    async insertOrder(input) {
      const inserted = await exec('order').insert({
        ulid: input.ulid,
        order_number: input.orderNumber,
        customer_id: input.customerId,
        merchant_id: input.merchantId,
        town_id: input.townId,
        zone_id: input.zoneId,
        delivery_address_id: input.deliveryAddressId,
        status: input.status,
        subtotal_cents: input.subtotalCents,
        delivery_fee_cents: input.deliveryFeeCents,
        service_fee_cents: input.serviceFeeCents,
        discount_cents: input.discountCents,
        total_cents: input.totalCents,
        commission_bps: input.commissionBps,
        commission_cents: input.commissionCents,
        distance_m: input.distanceM,
      });
      const id = inserted[0];
      if (id === undefined) {
        throw new Error('Failed to create order');
      }
      return Number(id);
    },

    async insertOrderItem(input) {
      const inserted = await exec('order_item').insert({
        order_id: input.orderId,
        product_id: input.productId,
        name_snapshot: input.nameSnapshot,
        unit_price_cents: input.unitPriceCents,
        quantity: input.quantity,
        line_total_cents: input.lineTotalCents,
      });
      const id = inserted[0];
      if (id === undefined) {
        throw new Error('Failed to create order item');
      }
      return Number(id);
    },

    async insertOrderItemOption(input) {
      await exec('order_item_option').insert({
        order_item_id: input.orderItemId,
        name_snapshot: input.nameSnapshot,
        price_delta_cents: input.priceDeltaCents,
      });
    },

    async insertStatusHistory(input) {
      await exec('order_status_history').insert({
        order_id: input.orderId,
        from_status: input.fromStatus,
        to_status: input.toStatus,
        actor_type: input.actorType,
        actor_user_id: input.actorUserId,
        reason: input.reason,
      });
    },

    async setOrderStatus(orderId, status, cancelledReason) {
      await exec('order')
        .where({ id: orderId })
        .update({ status, cancelled_reason: cancelledReason });
    },

    async clearCart(cartId) {
      await exec('cart_item').where({ cart_id: cartId }).del();
      await exec('cart').where({ id: cartId }).update({ merchant_id: null });
    },

    async findOrderByUlid(ulid) {
      const row = (await exec('order').where({ ulid }).first()) as OrderRowDb | undefined;
      return row ? mapOrder(row) : null;
    },

    async lockOrderByUlid(ulid) {
      const row = (await exec('order').where({ ulid }).forUpdate().first()) as
        OrderRowDb | undefined;
      return row ? mapOrder(row) : null;
    },

    async findMerchantStaffUlids(merchantId) {
      const rows = (await exec('merchant_user')
        .join('user', 'user.id', 'merchant_user.user_id')
        .where('merchant_user.merchant_id', merchantId)
        .select('user.ulid as ulid')) as Array<{ ulid: string }>;
      return rows.map((r) => r.ulid);
    },

    async findMerchantForStaff(userUlid) {
      const row = (await exec('merchant_user')
        .join('user', 'user.id', 'merchant_user.user_id')
        .join('merchant', 'merchant.id', 'merchant_user.merchant_id')
        .where('user.ulid', userUlid)
        .orderBy('merchant.id', 'asc')
        .first('merchant.id as id', 'merchant.ulid as ulid', 'merchant.name as name')) as
        { id: number | string; ulid: string; name: string } | undefined;
      return row ? { id: Number(row.id), ulid: row.ulid, name: row.name } : null;
    },

    async listMerchantOrders(merchantId) {
      const rows = (await exec('order')
        .where({ merchant_id: merchantId })
        .orderBy('id', 'desc')) as OrderRowDb[];
      return rows.map(mapOrder);
    },

    async listOrdersForUser(userId) {
      const rows = (await exec('order')
        .where({ customer_id: userId })
        .orderBy('id', 'desc')) as OrderRowDb[];
      return rows.map(mapOrder);
    },

    async listOrderStockLines(orderId) {
      const rows = (await exec('order_item')
        .where({ order_id: orderId })
        .select('product_id', 'quantity')) as Array<{
        product_id: number | string;
        quantity: number | string;
      }>;
      return rows.map((r) => ({ productId: Number(r.product_id), quantity: Number(r.quantity) }));
    },

    async getOrderItems(orderId) {
      const rows = (await exec('order_item')
        .join('product', 'product.id', 'order_item.product_id')
        .where('order_item.order_id', orderId)
        .orderBy('order_item.id', 'asc')
        .select(
          'order_item.id as id',
          'product.ulid as product_ulid',
          'order_item.name_snapshot as name_snapshot',
          'order_item.unit_price_cents as unit_price_cents',
          'order_item.quantity as quantity',
          'order_item.line_total_cents as line_total_cents',
        )) as Array<{
        id: number | string;
        product_ulid: string;
        name_snapshot: string;
        unit_price_cents: number | string;
        quantity: number | string;
        line_total_cents: number | string;
      }>;
      return rows.map((r) => ({
        id: Number(r.id),
        productUlid: r.product_ulid,
        nameSnapshot: r.name_snapshot,
        unitPriceCents: Number(r.unit_price_cents),
        quantity: Number(r.quantity),
        lineTotalCents: Number(r.line_total_cents),
      }));
    },

    async getOrderItemOptions(orderItemIds) {
      if (orderItemIds.length === 0) {
        return [];
      }
      const rows = (await exec('order_item_option')
        .whereIn('order_item_id', orderItemIds)
        .select('order_item_id', 'name_snapshot', 'price_delta_cents')) as Array<{
        order_item_id: number | string;
        name_snapshot: string;
        price_delta_cents: number | string;
      }>;
      return rows.map((r) => ({
        orderItemId: Number(r.order_item_id),
        nameSnapshot: r.name_snapshot,
        priceDeltaCents: Number(r.price_delta_cents),
      }));
    },
  };
}
