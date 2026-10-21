import type { DarajaClient } from '../../payments/daraja/client';
import { toMsisdn, toShillings } from '../../payments/daraja/format';
import type { B2cInitiateResult, B2cInput, PayoutGateway } from '../gateway';

/**
 * Daraja B2C payout adapter (doc 07 §10): pays a merchant/rider via the B2C `PaymentRequest`,
 * authenticated by the initiator + RSA `SecurityCredential`. Reuses the shared OAuth `DarajaClient`.
 * The synchronous response returns a conversation id (stored as the payout's `external_ref`); the
 * final paid/failed outcome arrives asynchronously on the B2C ResultURL webhook and is matched back
 * by that id. Selected by `PAYMENT_PROVIDER`, so nothing outside this adapter changes on cutover.
 */
export interface DarajaPayoutGatewayConfig {
  client: DarajaClient;
  initiatorName: string;
  /** RSA-encrypted initiator password (see security-credential). */
  securityCredential: string;
  /** B2C short code funds are paid from (PartyA). */
  shortcode: string;
  resultUrl: string;
  timeoutUrl: string;
}

interface B2cResponse {
  ConversationID?: string;
  OriginatorConversationID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
}

export class DarajaPayoutGateway implements PayoutGateway {
  constructor(private readonly cfg: DarajaPayoutGatewayConfig) {}

  async initiateB2c(input: B2cInput): Promise<B2cInitiateResult> {
    if (!input.payeePhone) {
      throw new Error(
        `Payout ${input.reference} has no M-Pesa destination number for the ${input.payeeType}; cannot send B2C`,
      );
    }
    const payload = {
      InitiatorName: this.cfg.initiatorName,
      SecurityCredential: this.cfg.securityCredential,
      CommandID: 'BusinessPayment',
      Amount: toShillings(input.amountCents),
      PartyA: this.cfg.shortcode,
      PartyB: toMsisdn(input.payeePhone),
      Remarks: `Payout ${input.reference}`,
      QueueTimeOutURL: this.cfg.timeoutUrl,
      ResultURL: this.cfg.resultUrl,
      Occasion: input.reference,
    };
    const res = await this.cfg.client.postJson<B2cResponse>(
      '/mpesa/b2c/v1/paymentrequest',
      payload,
    );
    if (res.ResponseCode !== '0' || !res.ConversationID) {
      throw new Error(
        `Daraja B2C rejected (ResponseCode=${res.ResponseCode ?? 'none'}: ${res.ResponseDescription ?? ''})`,
      );
    }
    return { externalRef: res.ConversationID };
  }
}
