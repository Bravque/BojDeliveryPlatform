/**
 * Payout provider abstraction (doc 07 §10). `SimulatedPayoutGateway` is used until Phase 8, when a
 * real Daraja B2C adapter swaps in without touching the payout service. `initiateB2c` returns a
 * provider reference; the result (paid/failed) is confirmed out-of-band (dev-simulate / webhook),
 * mirroring the STK capture + refund-reversal seams.
 */
export interface B2cInput {
  payeeType: 'merchant' | 'rider';
  payeeId: number;
  amountCents: number;
  reference: string; // the payout ulid
}

export interface B2cInitiateResult {
  externalRef: string;
}

export interface PayoutGateway {
  initiateB2c(input: B2cInput): Promise<B2cInitiateResult>;
}

export class SimulatedPayoutGateway implements PayoutGateway {
  initiateB2c(input: B2cInput): Promise<B2cInitiateResult> {
    return Promise.resolve({ externalRef: `SIMB2C-${input.reference.slice(-12).toUpperCase()}` });
  }
}
