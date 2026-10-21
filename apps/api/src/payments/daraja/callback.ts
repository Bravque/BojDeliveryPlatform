import type { StkCallback } from '../capture';

/**
 * Maps Daraja's nested STK callback JSON (doc 07 §3) to the normalised `StkCallback` the capture
 * service consumes. Daraja reports `Amount` in whole **shillings**; we store integer **cents**, so
 * amounts are scaled ×100. On failure there is no `CallbackMetadata`, so amount/receipt are null.
 */

interface DarajaCallbackItem {
  Name: string;
  Value?: string | number;
}

export interface DarajaStkCallbackBody {
  Body?: {
    stkCallback?: {
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      ResultCode?: number | string;
      ResultDesc?: string;
      CallbackMetadata?: { Item?: DarajaCallbackItem[] };
    };
  };
}

/** True when the body looks like a Daraja STK callback (vs. our normalised test/dev shape). */
export function isDarajaStkCallback(body: unknown): body is DarajaStkCallbackBody {
  return typeof (body as DarajaStkCallbackBody)?.Body?.stkCallback?.CheckoutRequestID === 'string';
}

export function mapDarajaStkCallback(body: DarajaStkCallbackBody): StkCallback {
  const cb = body.Body?.stkCallback;
  if (!cb?.CheckoutRequestID) {
    throw new Error('Not a Daraja STK callback');
  }
  const items = cb.CallbackMetadata?.Item ?? [];
  const valueOf = (name: string): string | number | undefined =>
    items.find((i) => i.Name === name)?.Value;

  const amount = valueOf('Amount');
  const receipt = valueOf('MpesaReceiptNumber');
  return {
    checkoutRequestId: cb.CheckoutRequestID,
    merchantRequestId: cb.MerchantRequestID ?? null,
    resultCode: Number(cb.ResultCode ?? -1),
    resultDesc: cb.ResultDesc ?? '',
    amountCents: amount != null ? Math.round(Number(amount) * 100) : null,
    mpesaReceipt: receipt != null ? String(receipt) : null,
  };
}
