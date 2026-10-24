import { describe, expect, it, vi } from 'vitest';
import { createCustomerModel } from './customerFlow';
import type { ApiClient, OrderDetail, PublicCatalogue, PublicMerchant } from './api';

const merchant = (ulid: string, name: string): PublicMerchant => ({
  ulid,
  name,
  categoryType: 'food',
  prepMinutes: 20,
  isOpen: true,
  townName: 'Migori',
});

const catalogue = (): PublicCatalogue => ({
  merchant: merchant('M1', 'Joe Kitchen'),
  categories: [],
  uncategorizedProducts: [
    { ulid: 'P1', name: 'Ugali', description: null, priceCents: 20_000, currency: 'KES' },
  ],
});

function makeApi(over: Partial<ApiClient> = {}): ApiClient {
  return {
    requestOtp: vi.fn(() => Promise.resolve()),
    verifyOtp: vi.fn(() => Promise.resolve({ access: 'tok' })),
    listMerchants: vi.fn(() => Promise.resolve([merchant('M1', 'Joe Kitchen')])),
    getCatalogue: vi.fn(() => Promise.resolve(catalogue())),
    getOrder: vi.fn(() =>
      Promise.resolve<OrderDetail>({ ulid: 'O1', orderNumber: 'BOJ-1', status: 'placed' }),
    ),
    ...over,
  };
}

describe('customer flow — critical journey', () => {
  it('phone → OTP → browse → open merchant → track order', async () => {
    const api = makeApi();
    const model = createCustomerModel(api);

    await model.requestOtp('+254700000000');
    expect(model.getState().screen).toBe('otp');
    expect(model.getState().phone).toBe('+254700000000');

    await model.verifyOtp('123456');
    let s = model.getState();
    expect(s.token).toBe('tok');
    expect(s.screen).toBe('browse');
    expect(s.merchants.map((m) => m.ulid)).toEqual(['M1']);
    expect(api.verifyOtp).toHaveBeenCalledWith('+254700000000', '123456');

    await model.openMerchant('M1');
    s = model.getState();
    expect(s.screen).toBe('merchant');
    expect(s.catalogue?.merchant.name).toBe('Joe Kitchen');

    await model.trackOrder('O1');
    s = model.getState();
    expect(s.screen).toBe('track');
    expect(s.order?.orderNumber).toBe('BOJ-1');
  });

  it('refreshOrder re-fetches the tracked order on a realtime nudge (status advances)', async () => {
    let status = 'placed';
    const api = makeApi({
      getOrder: vi.fn(() =>
        Promise.resolve<OrderDetail>({ ulid: 'O1', orderNumber: 'BOJ-1', status }),
      ),
    });
    const model = createCustomerModel(api);
    await model.verifyOtp('123456');
    await model.trackOrder('O1');
    expect(model.getState().order?.status).toBe('placed');

    status = 'out_for_delivery'; // backend advanced; a socket nudge arrives
    await model.refreshOrder();
    expect(model.getState().order?.status).toBe('out_for_delivery');
    expect(api.getOrder).toHaveBeenCalledTimes(2);
  });

  it('surfaces an error and stays on the OTP screen when the code is invalid', async () => {
    const api = makeApi({ verifyOtp: vi.fn(() => Promise.reject(new Error('bad code'))) });
    const model = createCustomerModel(api);
    await model.requestOtp('+254700000000');
    await model.verifyOtp('000000');
    const s = model.getState();
    expect(s.error).toBe('Invalid code');
    expect(s.screen).toBe('otp');
    expect(s.token).toBeNull();
    expect(api.listMerchants).not.toHaveBeenCalled();
  });

  it('trackOrder requires a token', async () => {
    const api = makeApi();
    const model = createCustomerModel(api);
    await model.trackOrder('O1');
    expect(model.getState().error).toBe('Not signed in');
    expect(api.getOrder).not.toHaveBeenCalled();
  });

  it('notifies subscribers on state changes', async () => {
    const api = makeApi();
    const model = createCustomerModel(api);
    const seen: string[] = [];
    const unsub = model.subscribe((s) => seen.push(s.screen));
    await model.requestOtp('+254700000000');
    unsub();
    await model.verifyOtp('123456');
    expect(seen).toContain('otp');
  });
});
