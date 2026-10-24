import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogueProducts, createHttpApiClient, type PublicCatalogue } from './api';

function mockFetch(status: number, body: unknown) {
  return vi.fn((_input: string, _init?: RequestInit) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response),
  );
}

describe('customer api client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('verifyOtp posts phone+code to the verify endpoint and returns the access token', async () => {
    const fetchMock = mockFetch(200, { access: 'tok', refresh: 'r' });
    vi.stubGlobal('fetch', fetchMock);

    const api = createHttpApiClient('http://api');
    const result = await api.verifyOtp('+254700000000', '123456');

    expect(result.access).toBe('tok');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api/api/v1/auth/otp/verify');
    expect(JSON.parse(init!.body as string)).toEqual({
      phone: '+254700000000',
      code: '123456',
    });
  });

  it('listMerchants unwraps { items } and encodes the town filter', async () => {
    const fetchMock = mockFetch(200, { items: [{ ulid: 'M1', name: 'Joe Kitchen' }] });
    vi.stubGlobal('fetch', fetchMock);

    const api = createHttpApiClient('http://api');
    const merchants = await api.listMerchants('Migori');

    expect(merchants).toHaveLength(1);
    expect(merchants[0]!.name).toBe('Joe Kitchen');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api/api/v1/merchants?townName=Migori');
  });

  it('getOrder sends the bearer token', async () => {
    const fetchMock = mockFetch(200, { ulid: 'O1', orderNumber: 'BOJ-1', status: 'placed' });
    vi.stubGlobal('fetch', fetchMock);

    const api = createHttpApiClient('http://api');
    const order = await api.getOrder('tok', 'O1');

    expect(order.status).toBe('placed');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api/api/v1/orders/O1');
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', mockFetch(401, {}));
    const api = createHttpApiClient('http://api');
    await expect(api.verifyOtp('+254700000000', 'bad')).rejects.toThrow('Request failed: 401');
  });

  it('catalogueProducts flattens categorised + uncategorised products', () => {
    const catalogue: PublicCatalogue = {
      merchant: {
        ulid: 'M1',
        name: 'Joe Kitchen',
        categoryType: 'food',
        prepMinutes: 20,
        isOpen: true,
        townName: 'Migori',
      },
      categories: [
        {
          products: [
            { ulid: 'P1', name: 'Ugali', description: null, priceCents: 20_000, currency: 'KES' },
          ],
        },
      ],
      uncategorizedProducts: [
        { ulid: 'P2', name: 'Soda', description: null, priceCents: 5_000, currency: 'KES' },
      ],
    };
    expect(catalogueProducts(catalogue).map((p) => p.ulid)).toEqual(['P1', 'P2']);
  });
});
