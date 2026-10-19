import { newUlid } from '../auth/crypto';
import type {
  PaymentGateway,
  StkInitiateInput,
  StkInitiateResult,
  StkStatus,
  StkStatusResult,
} from './gateway';

/**
 * Deterministic in-process gateway for local/CI/staging (doc 07 §9). Initiation always accepts
 * (returns correlation ids, payment stays `pending`); the outcome is driven explicitly — by the
 * dev simulate endpoint / reconciliation in later increments — via `setOutcome`. This lets the
 * full capture/refund/reconciliation machinery be built and tested before real Daraja credentials.
 */
export class SimulatedGateway implements PaymentGateway {
  private readonly outcomes = new Map<string, StkStatus>();

  initiateStkPush(_input: StkInitiateInput): Promise<StkInitiateResult> {
    return Promise.resolve({
      checkoutRequestId: `SIM-${newUlid()}`,
      merchantRequestId: `SIMMR-${newUlid()}`,
    });
  }

  /** Pre-set the result a later `queryStkStatus` should report for a checkout (used by tests/reconciliation). */
  setOutcome(checkoutRequestId: string, status: StkStatus): void {
    this.outcomes.set(checkoutRequestId, status);
  }

  queryStkStatus(checkoutRequestId: string): Promise<StkStatusResult> {
    const status = this.outcomes.get(checkoutRequestId) ?? 'pending';
    if (status === 'success') {
      return Promise.resolve({
        status,
        resultCode: 0,
        resultDesc: 'The service request is processed successfully.',
        mpesaReceipt: `SIMRCPT${checkoutRequestId.slice(-8).toUpperCase()}`,
      });
    }
    if (status === 'failed') {
      return Promise.resolve({
        status,
        resultCode: 1032,
        resultDesc: 'Request cancelled by user.',
        mpesaReceipt: null,
      });
    }
    return Promise.resolve({
      status: 'pending',
      resultCode: 1037,
      resultDesc: 'STK push pending.',
      mpesaReceipt: null,
    });
  }
}
