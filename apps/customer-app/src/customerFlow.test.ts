import { describe, expect, it, vi } from 'vitest';
import { createCustomerModel } from './customerFlow';
import type { ApiClient, OrderDetail, PublicCatalogue, PublicMerchant, PublicProduct } from './api';

const product = (ulid = 'P1', priceCents = 20_000): PublicProduct => ({
  ulid,
  name: 'Ugali',
  description: null,
  priceCents,
  currency: 'KES',
});

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
    addToCart: vi.fn(() => Promise.resolve()),
    clearCart: vi.fn(() => Promise.resolve()),
    listAddresses: vi.fn(() =>
      Promise.resolve([{ ulid: 'A1', label: 'Home', line1: 'CBD', serviceable: true }]),
    ),
    createAddress: vi.fn(() =>
      Promise.resolve({ ulid: 'A2', label: 'Home', line1: 'CBD', serviceable: true }),
    ),
    quoteCart: vi.fn(() =>
      Promise.resolve({
        subtotalCents: 20_000,
        deliveryFeeCents: 15_000,
        serviceFeeCents: 0,
        discountCents: 0,
        totalCents: 35_000,
        currency: 'KES',
      }),
    ),
    createOrder: vi.fn(() =>
      Promise.resolve({
        ulid: 'O1',
        orderNumber: 'BOJ-1',
        status: 'payment_pending',
        totalCents: 35_000,
      }),
    ),
    payOrder: vi.fn(() =>
      Promise.resolve({ ulid: 'PAY1', status: 'pending', amountCents: 35_000 }),
    ),
    getOrder: vi.fn(() =>
      Promise.resolve<OrderDetail>({ ulid: 'O1', orderNumber: 'BOJ-1', status: 'placed' }),
    ),
    listOrders: vi.fn(() =>
      Promise.resolve([
        {
          ulid: 'O1',
          orderNumber: 'BOJ-1',
          status: 'placed',
          paymentStatus: 'paid',
          totalCents: 35_000,
          currency: 'KES',
          createdAt: '2026-10-28T00:00:00.000Z',
        },
      ]),
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
    expect(s.screen).toBe('home');
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

  it('checkout: add to basket → quote → place order → pay → track (payment pending)', async () => {
    const api = makeApi({
      getOrder: vi.fn(() =>
        Promise.resolve<OrderDetail>({
          ulid: 'O1',
          orderNumber: 'BOJ-1',
          status: 'payment_pending',
        }),
      ),
    });
    const model = createCustomerModel(api);
    await model.verifyOtp('123456');
    await model.openMerchant('M1');
    expect(api.clearCart).toHaveBeenCalled(); // clean cart per merchant

    await model.addToBasket(product('P1', 20_000));
    await model.addToBasket(product('P1', 20_000)); // same product → qty 2
    let s = model.getState();
    expect(s.basket).toHaveLength(1);
    expect(s.basket[0]?.qty).toBe(2);
    expect(api.addToCart).toHaveBeenCalledTimes(2);

    await model.openCheckout();
    s = model.getState();
    expect(s.screen).toBe('checkout');
    expect(s.quote?.totalCents).toBe(35_000);
    expect(s.address?.ulid).toBe('A1');

    await model.placeOrder();
    s = model.getState();
    expect(s.screen).toBe('track');
    expect(s.order?.status).toBe('payment_pending');
    expect(s.basket).toEqual([]);
    expect(api.createOrder).toHaveBeenCalledWith('tok', 'A1');
    expect(api.payOrder).toHaveBeenCalled();
  });

  it('openCheckout creates a default address when none is serviceable', async () => {
    const api = makeApi({ listAddresses: vi.fn(() => Promise.resolve([])) });
    const model = createCustomerModel(api);
    await model.verifyOtp('123456');
    await model.openMerchant('M1');
    await model.addToBasket(product());
    await model.openCheckout();
    expect(api.createAddress).toHaveBeenCalled();
    expect(model.getState().address?.ulid).toBe('A2');
  });

  it('addToBasket reverts the optimistic line on API failure', async () => {
    const api = makeApi({ addToCart: vi.fn(() => Promise.reject(new Error('cart err'))) });
    const model = createCustomerModel(api);
    await model.verifyOtp('123456');
    await model.openMerchant('M1');
    await model.addToBasket(product());
    const s = model.getState();
    expect(s.basket).toEqual([]);
    expect(s.error).toBe('Could not add to basket');
  });

  it('tab nav: goToTab switches tabs, Orders loads history, Account sign-out resets', async () => {
    const api = makeApi();
    const model = createCustomerModel(api);
    await model.verifyOtp('123456');
    expect(model.getState().screen).toBe('home');

    model.goToTab('stores');
    expect(model.getState().screen).toBe('stores');

    model.goToTab('orders');
    await new Promise((r) => setTimeout(r, 0)); // loadOrders fires async
    const s = model.getState();
    expect(s.screen).toBe('orders');
    expect(api.listOrders).toHaveBeenCalled();
    expect(s.orders.map((o) => o.orderNumber)).toEqual(['BOJ-1']);

    model.signOut();
    expect(model.getState().screen).toBe('phone');
    expect(model.getState().token).toBeNull();
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
