import { describe, expect, it } from 'vitest';
import { isDarajaStkCallback, mapDarajaStkCallback } from './callback';

const success = {
  Body: {
    stkCallback: {
      MerchantRequestID: 'mr-1',
      CheckoutRequestID: 'ws_CO_123',
      ResultCode: 0,
      ResultDesc: 'The service request is processed successfully.',
      CallbackMetadata: {
        Item: [
          { Name: 'Amount', Value: 1500 },
          { Name: 'MpesaReceiptNumber', Value: 'QGH7XYZ123' },
          { Name: 'PhoneNumber', Value: 254700000001 },
        ],
      },
    },
  },
};

const failure = {
  Body: {
    stkCallback: {
      MerchantRequestID: 'mr-2',
      CheckoutRequestID: 'ws_CO_456',
      ResultCode: 1032,
      ResultDesc: 'Request cancelled by user',
    },
  },
};

describe('Daraja STK callback mapping', () => {
  it('detects the Daraja nested shape vs the normalised shape', () => {
    expect(isDarajaStkCallback(success)).toBe(true);
    expect(isDarajaStkCallback({ checkoutRequestId: 'x', resultCode: 0 })).toBe(false);
    expect(isDarajaStkCallback(null)).toBe(false);
  });

  it('maps a success: amount shillings→cents, receipt extracted', () => {
    expect(mapDarajaStkCallback(success)).toEqual({
      checkoutRequestId: 'ws_CO_123',
      merchantRequestId: 'mr-1',
      resultCode: 0,
      resultDesc: 'The service request is processed successfully.',
      amountCents: 150_000,
      mpesaReceipt: 'QGH7XYZ123',
    });
  });

  it('maps a failure (no metadata) to null amount/receipt', () => {
    expect(mapDarajaStkCallback(failure)).toEqual({
      checkoutRequestId: 'ws_CO_456',
      merchantRequestId: 'mr-2',
      resultCode: 1032,
      resultDesc: 'Request cancelled by user',
      amountCents: null,
      mpesaReceipt: null,
    });
  });
});
