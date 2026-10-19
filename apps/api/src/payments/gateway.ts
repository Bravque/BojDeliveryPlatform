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
  amountCents: number | null;
  mpesaReceipt: string | null;
}

/** Input for a refund reversal (Daraja reversal / B2C in Phase 8; simulated until then). */
export interface ReversalInput {
  /** The M-Pesa receipt of the captured payment being reversed, when known. */
  originalReceipt: string | null;
  checkoutRequestId: string | null;
  amountCents: number;
  /** A caller reference echoed back by the provider (the refund ulid). */
  reference: string;
}

export interface ReversalInitiateResult {
  /** Provider-side reversal / B2C id, stored on the refund as `provider_ref`. */
  reversalId: string;
}

export interface PaymentGateway {
  /** Begin an STK push; returns the correlation ids. */
  initiateStkPush(input: StkInitiateInput): Promise<StkInitiateResult>;
  /** Query the current STK result (used by capture confirmation + reconciliation). */
  queryStkStatus(checkoutRequestId: string): Promise<StkStatusResult>;
  /** Begin a refund reversal; completion is confirmed out-of-band (dev-simulate / reconcile). */
  initiateReversal(input: ReversalInput): Promise<ReversalInitiateResult>;
}
