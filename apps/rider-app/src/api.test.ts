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

  it('throws on a non-2xx (e.g. 409 offer already taken)', async () => {
    vi.stubGlobal('fetch', mockFetch(409, {}));
    const api = createHttpApiClient('http://api');
    await expect(api.acceptOffer('tok', 7)).rejects.toThrow('Request failed: 409');
  });
});
