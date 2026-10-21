import type {
  PaymentGateway,
  ReversalInitiateResult,
  ReversalInput,
  StkInitiateInput,
  StkInitiateResult,
  StkStatusResult,
} from '../gateway';
import type { DarajaClient, DarajaHttpError } from './client';

/**
 * Daraja STK adapter (doc 07 §2–3). Implements the money-in path (`initiateStkPush` +
 * `queryStkStatus`) behind the shared `PaymentGateway` interface, so flipping `PAYMENT_PROVIDER`
 * to a Daraja value changes nothing outside this folder. Capture is driven by the verified
 * callback (which carries the amount); the STK Query API is a status-only backstop.
 *
 * `initiateReversal` (refund via Daraja) shares the RSA `SecurityCredential` machinery with B2C and
 * is implemented in the next increment.
 */

export interface DarajaGatewayConfig {
  client: DarajaClient;
  shortcode: string;
  passkey: string;
  callbackUrl: string;
  /** Clock for the STK timestamp; injectable for deterministic tests. */
  now?: () => Date;
}

/** Daraja "transaction is being processed" — the STK is still pending when we query. */
const STILL_PROCESSING = '500.001.1001';

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Daraja timestamp format `YYYYMMDDHHmmss`. */
function stkTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** M-Pesa amounts are whole KES shillings; our ledger is integer cents. */
function toShillings(amountCents: number): number {
  if (amountCents % 100 !== 0) {
    throw new Error(
      `Amount ${amountCents} cents is not a whole KES shilling; M-Pesa amounts must be whole shillings`,
    );
  }
  return amountCents / 100;
}

/** Normalise a stored phone to an M-Pesa MSISDN (digits only, e.g. 2547XXXXXXXX). */
function toMsisdn(phone: string | null): string {
  if (!phone) {
    throw new Error('STK push requires a customer phone number');
  }
  return phone.replace(/[^0-9]/g, '');
}

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
    const timestamp = stkTimestamp(this.now());
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
    const timestamp = stkTimestamp(this.now());
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

  initiateReversal(_input: ReversalInput): Promise<ReversalInitiateResult> {
    return Promise.reject(
      new Error(
        'Daraja reversal is implemented in the next increment (shares the B2C security credential)',
      ),
    );
  }
}
