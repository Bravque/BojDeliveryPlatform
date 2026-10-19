/**
 * Payment provider abstraction (doc 07 §2). The same interface backs `SimulatedGateway` (now) and
 * `DarajaGateway` (Phase 8); switching `PAYMENT_PROVIDER` must not change anything outside the
 * adapter. STK correlation is by `checkoutRequestId`; the backend verifies the amount and treats
 * callbacks as hints to be confirmed.
 */

export interface StkInitiateInput {
  orderNumber: string;
  amountCents: number;
  phone: string | null;
  idempotencyKey: string;
}

export interface StkInitiateResult {
  checkoutRequestId: string;
  merchantRequestId: string;
}

export type StkStatus = 'success' | 'failed' | 'pending';

export interface StkStatusResult {
  status: StkStatus;
  resultCode: number;
  resultDesc: string;
  mpesaReceipt: string | null;
}

export interface PaymentGateway {
  /** Begin an STK push; returns the correlation ids. */
  initiateStkPush(input: StkInitiateInput): Promise<StkInitiateResult>;
  /** Query the current STK result (used by capture confirmation + reconciliation). */
  queryStkStatus(checkoutRequestId: string): Promise<StkStatusResult>;
}
