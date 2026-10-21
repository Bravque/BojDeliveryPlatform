import type {
  PaymentGateway,
  ReversalInitiateResult,
  ReversalInput,
  StkInitiateInput,
  StkInitiateResult,
  StkStatusResult,
} from '../gateway';
import type { DarajaClient, DarajaHttpError } from './client';
import { darajaTimestamp, toMsisdn, toShillings } from './format';

/**
 * Daraja STK adapter (doc 07 §2–3). Implements the money-in path (`initiateStkPush` +
 * `queryStkStatus`) and the refund money-out path (`initiateReversal`) behind the shared
 * `PaymentGateway` interface, so flipping `PAYMENT_PROVIDER` to a Daraja value changes nothing
 * outside this folder. Capture is driven by the verified callback (which carries the amount); the
 * STK Query API is a status-only backstop.
 */

/** Initiator-side config shared with B2C, required for the authenticated reversal API. */
export interface DarajaReversalConfig {
  initiatorName: string;
  /** RSA-encrypted initiator password (see security-credential). */
  securityCredential: string;
  /** Short code the reversal credits back to (ReceiverParty). */
  shortcode: string;
  resultUrl: string;
  timeoutUrl: string;
}

export interface DarajaGatewayConfig {
  client: DarajaClient;
  shortcode: string;
  passkey: string;
  callbackUrl: string;
  /** Required only to initiate refunds via Daraja TransactionReversal. */
  reversal?: DarajaReversalConfig;
  /** Clock for the STK timestamp; injectable for deterministic tests. */
  now?: () => Date;
}

/** Daraja "transaction is being processed" — the STK is still pending when we query. */
const STILL_PROCESSING = '500.001.1001';

interface StkPushResponse {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
}

interface StkQueryResponse {
  ResultCode?: string | number;
  ResultDesc?: string;
}

export class DarajaGateway implements PaymentGateway {
  constructor(private readonly cfg: DarajaGatewayConfig) {}

  private now(): Date {
    return (this.cfg.now ?? (() => new Date()))();
  }

  private password(timestamp: string): string {
    return Buffer.from(`${this.cfg.shortcode}${this.cfg.passkey}${timestamp}`).toString('base64');
  }

  async initiateStkPush(input: StkInitiateInput): Promise<StkInitiateResult> {
    const timestamp = darajaTimestamp(this.now());
    const msisdn = toMsisdn(input.phone);
    const payload = {
      BusinessShortCode: this.cfg.shortcode,
      Password: this.password(timestamp),
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: toShillings(input.amountCents),
      PartyA: msisdn,
      PartyB: this.cfg.shortcode,
      PhoneNumber: msisdn,
      CallBackURL: this.cfg.callbackUrl,
      AccountReference: input.orderNumber,
      TransactionDesc: `Order ${input.orderNumber}`,
    };
    const res = await this.cfg.client.postJson<StkPushResponse>(
      '/mpesa/stkpush/v1/processrequest',
      payload,
    );
    if (res.ResponseCode !== '0' || !res.CheckoutRequestID) {
      throw new Error(
        `Daraja STK push rejected (ResponseCode=${res.ResponseCode ?? 'none'}: ${res.ResponseDescription ?? ''})`,
      );
    }
    return {
      checkoutRequestId: res.CheckoutRequestID,
      merchantRequestId: res.MerchantRequestID ?? '',
    };
  }

  async queryStkStatus(checkoutRequestId: string): Promise<StkStatusResult> {
    const timestamp = darajaTimestamp(this.now());
    const payload = {
      BusinessShortCode: this.cfg.shortcode,
      Password: this.password(timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    };
    let body: StkQueryResponse;
    try {
      body = await this.cfg.client.postJson<StkQueryResponse>(
        '/mpesa/stkpushquery/v1/query',
        payload,
      );
    } catch (e) {
      // While the STK is still being processed Daraja returns an error body, not a result.
      const err = e as DarajaHttpError;
      const code = (err.body as { errorCode?: string } | undefined)?.errorCode;
      if (code === STILL_PROCESSING) {
        return {
          status: 'pending',
          resultCode: 1037,
          resultDesc: 'Processing',
          amountCents: null,
          mpesaReceipt: null,
        };
      }
      throw e;
    }
    const resultCode = Number(body.ResultCode ?? -1);
    const resultDesc = body.ResultDesc ?? '';
    // The STK Query API returns neither the amount nor the receipt — only status. Capture verifies
    // the amount from the callback; a query-confirmed success without a callback stays unverified
    // (amountCents null → the capture service quarantines rather than capturing an unverified sum).
    return resultCode === 0
      ? { status: 'success', resultCode, resultDesc, amountCents: null, mpesaReceipt: null }
      : { status: 'failed', resultCode, resultDesc, amountCents: null, mpesaReceipt: null };
  }

  /**
   * Refund via Daraja TransactionReversal (doc 07 §8). Requires the original M-Pesa receipt and the
   * initiator credentials. Returns the provider conversation id as the reversal reference; the final
   * reversal result is confirmed out-of-band via the existing refund confirm seam.
   */
  async initiateReversal(input: ReversalInput): Promise<ReversalInitiateResult> {
    const r = this.cfg.reversal;
    if (!r) {
      throw new Error(
        'Daraja reversal is not configured (initiator + security credential required)',
      );
    }
    if (!input.originalReceipt) {
      throw new Error('Daraja reversal requires the original M-Pesa receipt (TransactionID)');
    }
    const payload = {
      Initiator: r.initiatorName,
      SecurityCredential: r.securityCredential,
      CommandID: 'TransactionReversal',
      TransactionID: input.originalReceipt,
      Amount: toShillings(input.amountCents),
      ReceiverParty: r.shortcode,
      RecieverIdentifierType: '11', // organisation short code (Daraja's documented spelling)
      ResultURL: r.resultUrl,
      QueueTimeOutURL: r.timeoutUrl,
      Remarks: `Refund ${input.reference}`,
      Occasion: input.reference,
    };
    const res = await this.cfg.client.postJson<{
      ConversationID?: string;
      ResponseCode?: string;
      ResponseDescription?: string;
    }>('/mpesa/reversal/v1/request', payload);
    if (res.ResponseCode !== '0' || !res.ConversationID) {
      throw new Error(
        `Daraja reversal rejected (ResponseCode=${res.ResponseCode ?? 'none'}: ${res.ResponseDescription ?? ''})`,
      );
    }
    return { reversalId: res.ConversationID };
  }
}
