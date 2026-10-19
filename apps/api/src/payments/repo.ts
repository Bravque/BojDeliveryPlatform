import type { Knex } from 'knex';
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
  };
}
