import { conflict } from '../http/errors';

/**
 * Order lifecycle (doc 04). The full allowed-transition table is encoded here so later phases
 * (payment, merchant accept, delivery) plug in without re-deriving the rules; Phase 3 only drives
 * `[*] → draft` (creation) and `draft → cancelled`. Any transition not listed is rejected with a
 * typed 409, and every applied transition is recorded in `order_status_history` by the caller.
 */

export type OrderStatus =
  | 'draft'
  | 'payment_pending'
  | 'payment_failed'
  | 'placed'
  | 'merchant_accepted'
  | 'preparing'
  | 'ready_for_pickup'
  | 'rider_assigned'
  | 'picked_up'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled'
  | 'rejected'
  | 'refunded';

export type ActorType = 'customer' | 'merchant' | 'rider' | 'admin' | 'system';

const ALLOWED: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ['payment_pending', 'cancelled'],
  payment_pending: ['placed', 'payment_failed'],
  payment_failed: ['payment_pending', 'cancelled'],
  placed: ['merchant_accepted', 'rejected', 'cancelled'],
  merchant_accepted: ['preparing', 'cancelled'],
  preparing: ['ready_for_pickup', 'cancelled'],
  ready_for_pickup: ['rider_assigned', 'cancelled'],
  rider_assigned: ['picked_up', 'ready_for_pickup'],
  picked_up: ['out_for_delivery'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: ['refunded'],
  rejected: ['refunded'],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** Throw a typed 409 if `from → to` is not an allowed transition. */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw conflict('ILLEGAL_TRANSITION', `Cannot move an order from ${from} to ${to}`);
  }
}
