import type { Knex } from 'knex';
import type { OrderMoneySnapshot } from './capture';
import type { ActorType, OrderStatus } from '../orders/state-machine';

/**
 * Payment persistence over a `Knex` executor, so initiation can insert the payment and transition
 * the order (+ history) in one transaction. Order reads/writes are the minimal subset payments
 * need; the orders module remains the owner of the richer order model.
 */

export type PaymentStatus =
  'initiated' | 'pending' | 'succeeded' | 'failed' | 'timed_out' | 'reversed';
export type PaymentMethod = 'mpesa_stk' | 'cash' | 'simulated';

export interface OrderForPayment {
  id: number;
  ulid: string;
  orderNumber: string;
  customerId: number;
  status: OrderStatus;
  totalCents: number;
  currency: string;
}

export interface PaymentRecord {
  id: number;
  ulid: string;
  orderId: number;
  method: PaymentMethod;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  checkoutRequestId: string | null;
  merchantRequestId: string | null;
  mpesaReceipt: string | null;
  idempotencyKey: string;
}

export interface InsertPaymentInput {
  ulid: string;
  orderId: number;
  method: PaymentMethod;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
}

export interface PaymentsRepo {
  findUserIdByUlid(ulid: string): Promise<number | null>;
  findOrderForPayment(orderUlid: string): Promise<OrderForPayment | null>;
  findPaymentByIdempotencyKey(key: string): Promise<PaymentRecord | null>;
  findPaymentByUlid(ulid: string): Promise<PaymentRecord | null>;
  findOrderUlidForPayment(
    paymentId: number,
  ): Promise<{ orderUlid: string; customerId: number } | null>;
  insertPayment(input: InsertPaymentInput): Promise<number>;
  markPending(
    paymentId: number,
    ids: { checkoutRequestId: string; merchantRequestId: string },
  ): Promise<void>;
  setOrderStatus(orderId: number, status: OrderStatus): Promise<void>;
  insertStatusHistory(input: {
    orderId: number;
    fromStatus: OrderStatus;
    toStatus: OrderStatus;
    actorType: ActorType;
    actorUserId: number | null;
  }): Promise<void>;

  // --- capture path (increment 3) ---
  findPaymentByCheckoutRequestId(checkoutRequestId: string): Promise<PaymentRecord | null>;
  /** Insert the raw event; returns false if `dedupeKey` already exists (duplicate callback). */
  insertPaymentEventDedup(input: {
    paymentId: number | null;
    source: 'stk_callback' | 'status_query' | 'reconciliation' | 'manual';
    dedupeKey: string;
    resultCode: number | null;
    rawPayload: unknown;
  }): Promise<boolean>;
  markPaymentSucceeded(paymentId: number, mpesaReceipt: string | null): Promise<void>;
  markPaymentFailed(paymentId: number, status: 'failed' | 'timed_out'): Promise<void>;
  getOrderMoneySnapshot(
    orderId: number,
  ): Promise<(OrderMoneySnapshot & { status: OrderStatus }) | null>;
  setOrderStatusAndPayment(
    orderId: number,
    status: OrderStatus,
    paymentStatus: 'paid' | 'failed',
  ): Promise<void>;
  listOrderStockLines(orderId: number): Promise<Array<{ productId: number; quantity: number }>>;
  releaseStock(productId: number, quantity: number): Promise<void>;

  // --- reconciliation (increment 4) ---
  /** Non-terminal payments (pending/initiated); with `olderThan`, only those initiated before it. */
  listOpenPayments(olderThan?: Date): Promise<PaymentRecord[]>;
}

interface PaymentRowDb {
  id: number | string;
  ulid: string;
  order_id: number | string;
  method: PaymentMethod;
  amount_cents: number | string;
  currency: string;
  status: PaymentStatus;
  checkout_request_id: string | null;
  merchant_request_id: string | null;
  mpesa_receipt: string | null;
  idempotency_key: string;
}

function mapPayment(row: PaymentRowDb): PaymentRecord {
  return {
    id: Number(row.id),
    ulid: row.ulid,
    orderId: Number(row.order_id),
    method: row.method,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    status: row.status,
    checkoutRequestId: row.checkout_request_id,
    merchantRequestId: row.merchant_request_id,
    mpesaReceipt: row.mpesa_receipt,
    idempotencyKey: row.idempotency_key,
  };
}

export function createKnexPaymentsRepo(exec: Knex): PaymentsRepo {
  return {
    async findUserIdByUlid(ulid) {
      const row = (await exec('user').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async findOrderForPayment(orderUlid) {
      const row = (await exec('order')
        .where({ ulid: orderUlid })
        .first(
          'id',
          'ulid',
          'order_number',
          'customer_id',
          'status',
          'total_cents',
          'currency',
        )) as
        | {
            id: number | string;
            ulid: string;
            order_number: string;
            customer_id: number | string;
            status: OrderStatus;
            total_cents: number | string;
            currency: string;
          }
        | undefined;
      if (!row) {
        return null;
      }
      return {
        id: Number(row.id),
        ulid: row.ulid,
        orderNumber: row.order_number,
        customerId: Number(row.customer_id),
        status: row.status,
        totalCents: Number(row.total_cents),
        currency: row.currency,
      };
    },

    async findPaymentByIdempotencyKey(key) {
      const row = (await exec('payment').where({ idempotency_key: key }).first()) as
        PaymentRowDb | undefined;
      return row ? mapPayment(row) : null;
    },

    async findPaymentByUlid(ulid) {
      const row = (await exec('payment').where({ ulid }).first()) as PaymentRowDb | undefined;
      return row ? mapPayment(row) : null;
    },

    async findOrderUlidForPayment(paymentId) {
      const row = (await exec('payment')
        .join('order', 'order.id', 'payment.order_id')
        .where('payment.id', paymentId)
        .first('order.ulid as order_ulid', 'order.customer_id as customer_id')) as
        { order_ulid: string; customer_id: number | string } | undefined;
      return row ? { orderUlid: row.order_ulid, customerId: Number(row.customer_id) } : null;
    },

    async insertPayment(input) {
      const inserted = await exec('payment').insert({
        ulid: input.ulid,
        order_id: input.orderId,
        method: input.method,
        amount_cents: input.amountCents,
        currency: input.currency,
        status: 'initiated',
        idempotency_key: input.idempotencyKey,
      });
      const id = inserted[0];
      if (id === undefined) {
        throw new Error('Failed to create payment');
      }
      return Number(id);
    },

    async markPending(paymentId, ids) {
      await exec('payment').where({ id: paymentId }).update({
        status: 'pending',
        checkout_request_id: ids.checkoutRequestId,
        merchant_request_id: ids.merchantRequestId,
      });
    },

    async setOrderStatus(orderId, status) {
      await exec('order').where({ id: orderId }).update({ status });
    },

    async insertStatusHistory(input) {
      await exec('order_status_history').insert({
        order_id: input.orderId,
        from_status: input.fromStatus,
        to_status: input.toStatus,
        actor_type: input.actorType,
        actor_user_id: input.actorUserId,
      });
    },

    async findPaymentByCheckoutRequestId(checkoutRequestId) {
      const row = (await exec('payment')
        .where({ checkout_request_id: checkoutRequestId })
        .first()) as PaymentRowDb | undefined;
      return row ? mapPayment(row) : null;
    },

    async insertPaymentEventDedup(input) {
      const inserted = await exec('payment_event')
        .insert({
          payment_id: input.paymentId,
          source: input.source,
          dedupe_key: input.dedupeKey,
          result_code: input.resultCode,
          raw_payload: JSON.stringify(input.rawPayload),
        })
        .onConflict('dedupe_key')
        .ignore();
      // knex returns affected rows; 0 means the dedupe_key already existed.
      const affected = Array.isArray(inserted) ? (inserted[0] ?? 0) : inserted;
      return Number(affected) > 0;
    },

    async markPaymentSucceeded(paymentId, mpesaReceipt) {
      await exec('payment')
        .where({ id: paymentId })
        .update({
          status: 'succeeded',
          mpesa_receipt: mpesaReceipt,
          settled_at: exec.raw('CURRENT_TIMESTAMP(3)'),
        });
    },

    async markPaymentFailed(paymentId, status) {
      await exec('payment').where({ id: paymentId }).update({ status });
    },

    async getOrderMoneySnapshot(orderId) {
      const row = (await exec('order')
        .where({ id: orderId })
        .first(
          'id',
          'merchant_id',
          'status',
          'subtotal_cents',
          'delivery_fee_cents',
          'service_fee_cents',
          'discount_cents',
          'total_cents',
          'commission_cents',
        )) as
        | {
            id: number | string;
            merchant_id: number | string;
            status: OrderStatus;
            subtotal_cents: number | string;
            delivery_fee_cents: number | string;
            service_fee_cents: number | string;
            discount_cents: number | string;
            total_cents: number | string;
            commission_cents: number | string;
          }
        | undefined;
      if (!row) {
        return null;
      }
      return {
        id: Number(row.id),
        merchantId: Number(row.merchant_id),
        status: row.status,
        subtotalCents: Number(row.subtotal_cents),
        deliveryFeeCents: Number(row.delivery_fee_cents),
        serviceFeeCents: Number(row.service_fee_cents),
        discountCents: Number(row.discount_cents),
        totalCents: Number(row.total_cents),
        commissionCents: Number(row.commission_cents),
      };
    },

    async setOrderStatusAndPayment(orderId, status, paymentStatus) {
      await exec('order').where({ id: orderId }).update({ status, payment_status: paymentStatus });
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

    async releaseStock(productId, quantity) {
      await exec('inventory')
        .where('product_id', productId)
        .where('track_stock', true)
        .update({ reserved: exec.raw('GREATEST(reserved - ?, 0)', [quantity]) });
    },

    async listOpenPayments(olderThan) {
      const query = exec('payment')
        .whereIn('status', ['pending', 'initiated'])
        .orderBy('id', 'asc');
      if (olderThan) {
        query.where('initiated_at', '<', olderThan);
      }
      const rows = (await query) as PaymentRowDb[];
      return rows.map(mapPayment);
    },
  };
}
