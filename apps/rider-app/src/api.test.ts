import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApiClient } from './api';

function mockFetch(status: number, body: unknown) {
  return vi.fn((_input: string, _init?: RequestInit) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response),
  );
}

describe('rider api client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('verifyOtp posts phone+code to the verify endpoint', async () => {
    const fetchMock = mockFetch(200, { access: 'tok' });
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApiClient('http://api');

    const result = await api.verifyOtp('+254700000000', '123456');

    expect(result.access).toBe('tok');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api/api/v1/auth/otp/verify');
    expect(JSON.parse(init!.body as string)).toEqual({ phone: '+254700000000', code: '123456' });
  });

  it('listOffers unwraps { items } and sends the bearer token', async () => {
    const fetchMock = mockFetch(200, {
      items: [{ offerId: 7, orderUlid: 'O1', expiresAt: '2026-10-25T00:00:10.000Z' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApiClient('http://api');

    const offers = await api.listOffers('tok');

    expect(offers[0]!.offerId).toBe(7);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api/api/v1/rider/offers');
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('acceptOffer posts to the accept path with the bearer token', async () => {
    const fetchMock = mockFetch(200, {
      orderUlid: 'O1',
      status: 'rider_assigned',
      deliveryId: 3,
      riderFeeCents: 15_000,
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApiClient('http://api');

    const view = await api.acceptOffer('tok', 7);

    expect(view.orderUlid).toBe('O1');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api/api/v1/rider/offers/7/accept');
  });

  it('completeDelivery posts the PIN to the complete path', async () => {
    const fetchMock = mockFetch(200, {
      orderUlid: 'O1',
      orderStatus: 'delivered',
      deliveryStatus: 'delivered',
      riderFeeCents: 15_000,
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApiClient('http://api');

    const view = await api.completeDelivery('tok', 'O1', '1234');

    expect(view.deliveryStatus).toBe('delivered');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api/api/v1/rider/deliveries/O1/complete');
    expect(JSON.parse(init!.body as string)).toEqual({ pin: '1234' });
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('getMe fetches the rider profile with the bearer token', async () => {
    const fetchMock = mockFetch(200, {
      status: 'approved',
      vehicleType: 'motorbike',
      isOnline: true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApiClient('http://api');

    const me = await api.getMe('tok');

    expect(me.vehicleType).toBe('motorbike');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api/api/v1/rider/me');
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('getEarnings fetches the rider earnings with the bearer token', async () => {
    const fetchMock = mockFetch(200, { deliveries: 3, totalEarnedCents: 21_000 });
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApiClient('http://api');

    const earnings = await api.getEarnings('tok');

    expect(earnings).toEqual({ deliveries: 3, totalEarnedCents: 21_000 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api/api/v1/rider/earnings');
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('setPayoutDestination posts the phone and returns the updated profile', async () => {
    const fetchMock = mockFetch(200, {
      status: 'approved',
      vehicleType: 'motorbike',
      isOnline: true,
      payoutPhoneE164: '+254712345678',
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApiClient('http://api');

    const me = await api.setPayoutDestination('tok', '0712345678');

    expect(me.payoutPhoneE164).toBe('+254712345678');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api/api/v1/rider/payout-destination');
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(JSON.parse(init!.body as string)).toEqual({ phone: '0712345678' });
  });

  it('apply posts the vehicle type and returns the new (pending) profile', async () => {
    const fetchMock = mockFetch(201, {
      status: 'pending',
      vehicleType: 'bicycle',
      isOnline: false,
      payoutPhoneE164: null,
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApiClient('http://api');

    const me = await api.apply('tok', 'bicycle');

    expect(me.status).toBe('pending');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api/api/v1/rider/apply');
    expect(JSON.parse(init!.body as string)).toEqual({ vehicleType: 'bicycle' });
  });

  it('ping posts coordinates with the bearer token', async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApiClient('http://api');

    await api.ping('tok', -1.0634, 34.4731);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api/api/v1/rider/ping');
    expect(JSON.parse(init!.body as string)).toEqual({ lat: -1.0634, lng: 34.4731 });
  });

  it('declineOffer posts to the decline path', async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApiClient('http://api');

    await api.declineOffer('tok', 7);

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api/api/v1/rider/offers/7/decline');
  });

  it('throws an ApiError carrying the status on a non-2xx', async () => {
    vi.stubGlobal('fetch', mockFetch(409, {}));
    const api = createHttpApiClient('http://api');
    await expect(api.acceptOffer('tok', 7)).rejects.toMatchObject({ status: 409 });
    await expect(api.acceptOffer('tok', 7)).rejects.toThrow('Request failed: 409');
  });
});
