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
interface SimulatedOutcome {
  status: StkStatus;
  amountCents?: number | null;
}

export class SimulatedGateway implements PaymentGateway {
  private readonly outcomes = new Map<string, SimulatedOutcome>();

  initiateStkPush(_input: StkInitiateInput): Promise<StkInitiateResult> {
    return Promise.resolve({
      checkoutRequestId: `SIM-${newUlid()}`,
      merchantRequestId: `SIMMR-${newUlid()}`,
    });
  }

  /**
   * Pre-set the result a later `queryStkStatus` should report for a checkout (used by tests and
   * reconciliation). `amountCents` is the amount the gateway reports it collected on success.
   */
  setOutcome(checkoutRequestId: string, status: StkStatus, amountCents?: number | null): void {
    this.outcomes.set(checkoutRequestId, { status, amountCents });
  }

  queryStkStatus(checkoutRequestId: string): Promise<StkStatusResult> {
    const outcome = this.outcomes.get(checkoutRequestId) ?? { status: 'pending' };
    if (outcome.status === 'success') {
      return Promise.resolve({
        status: 'success',
        resultCode: 0,
        resultDesc: 'The service request is processed successfully.',
        amountCents: outcome.amountCents ?? null,
        mpesaReceipt: `SIMRCPT${checkoutRequestId.slice(-8).toUpperCase()}`,
      });
    }
    if (outcome.status === 'failed') {
      return Promise.resolve({
        status: 'failed',
        resultCode: 1032,
        resultDesc: 'Request cancelled by user.',
        amountCents: null,
        mpesaReceipt: null,
      });
    }
    return Promise.resolve({
      status: 'pending',
      resultCode: 1037,
      resultDesc: 'STK push pending.',
      amountCents: null,
      mpesaReceipt: null,
    });
  }
}
