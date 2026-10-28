/**
 * Thin typed REST client for the customer app. Pure (uses the global `fetch` that both Node and
 * React Native provide), so it is unit-tested in CI without a native runtime. Types mirror the
 * server DTOs (`auth/*`, `browse/service.ts`, `pricing/*`, `orders/*`). Canonical state always
 * comes from here; realtime is only a nudge to re-fetch (doc 02 §4).
 */

export interface AuthResult {
  access: string;
}

/** Mirrors `PublicMerchant`. */
export interface PublicMerchant {
  ulid: string;
  name: string;
  categoryType: string;
  prepMinutes: number;
  isOpen: boolean;
  townName: string;
}

/** Mirrors `PublicProduct` (option groups omitted — not needed for the browse MVP). */
export interface PublicProduct {
  ulid: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
}

/** Mirrors `PublicCategory` — only the fields the app reads. */
export interface PublicCategory {
  products: PublicProduct[];
}

/** Mirrors `PublicCatalogue`. */
export interface PublicCatalogue {
  merchant: PublicMerchant;
  categories: PublicCategory[];
  uncategorizedProducts: PublicProduct[];
}

/** Mirrors `AddressSummary` (`GET /addresses`). */
export interface AddressSummary {
  ulid: string;
  label: string | null;
  line1: string;
  serviceable: boolean;
}

/** Mirrors the authoritative `QuoteBreakdown` (`POST /cart/quote`). */
export interface QuoteBreakdown {
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  discountCents: number;
  totalCents: number;
  currency: string;
}

/** The order returned by `POST /orders`. */
export interface CreatedOrder {
  ulid: string;
  orderNumber: string;
  status: string;
  totalCents: number;
}

/** Mirrors `PaymentView` (`POST /orders/:ulid/pay`). */
export interface Payment {
  ulid: string;
  status: string;
  amountCents: number;
}

/** Minimal order view for tracking (`GET /orders/:ulid`). */
export interface OrderDetail {
  ulid: string;
  orderNumber: string;
  status: string;
  paymentStatus?: string;
  totalCents?: number;
}

/** A row in the customer's order history (`GET /orders`). */
export interface OrderSummary {
  ulid: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  totalCents: number;
  currency: string;
  createdAt: string;
}

export interface ApiClient {
  requestOtp(phone: string): Promise<void>;
  verifyOtp(phone: string, code: string): Promise<AuthResult>;
  listMerchants(townName?: string): Promise<PublicMerchant[]>;
  getCatalogue(merchantUlid: string): Promise<PublicCatalogue>;
  addToCart(token: string, productUlid: string, quantity: number): Promise<void>;
  clearCart(token: string): Promise<void>;
  listAddresses(token: string): Promise<AddressSummary[]>;
  createAddress(
    token: string,
    input: { line1: string; lat: number; lng: number; label?: string },
  ): Promise<AddressSummary>;
  quoteCart(token: string, addressUlid: string): Promise<QuoteBreakdown>;
  createOrder(token: string, addressUlid: string): Promise<CreatedOrder>;
  payOrder(
    token: string,
    orderUlid: string,
    phone: string,
    idempotencyKey: string,
  ): Promise<Payment>;
  getOrder(token: string, orderUlid: string): Promise<OrderDetail>;
  listOrders(token: string): Promise<OrderSummary[]>;
}

export function createHttpApiClient(baseUrl: string): ApiClient {
  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) {
      throw new Error(`Request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /** Fire a request we don't need a body back from (throws on non-2xx). */
  async function send(path: string, init: RequestInit): Promise<void> {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) {
      throw new Error(`Request failed: ${res.status}`);
    }
  }

  function postJson(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  function authJson(
    token: string,
    method: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): RequestInit {
    return {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(extra ?? {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
  }

  function auth(token: string): RequestInit {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  return {
    async requestOtp(phone) {
      await json('/api/v1/auth/otp/request', postJson({ phone }));
    },
    async verifyOtp(phone, code) {
      return json<AuthResult>('/api/v1/auth/otp/verify', postJson({ phone, code }));
    },
    async listMerchants(townName) {
      const q = townName ? `?townName=${encodeURIComponent(townName)}` : '';
      const { items } = await json<{ items: PublicMerchant[] }>(`/api/v1/merchants${q}`);
      return items;
    },
    async getCatalogue(merchantUlid) {
      return json<PublicCatalogue>(`/api/v1/merchants/${merchantUlid}/catalogue`);
    },
    async addToCart(token, productUlid, quantity) {
      await send('/api/v1/cart/items', authJson(token, 'POST', { productUlid, quantity }));
    },
    async clearCart(token) {
      await send('/api/v1/cart', authJson(token, 'DELETE'));
    },
    async listAddresses(token) {
      const { items } = await json<{ items: AddressSummary[] }>('/api/v1/addresses', auth(token));
      return items;
    },
    async createAddress(token, input) {
      return json<AddressSummary>('/api/v1/addresses', authJson(token, 'POST', input));
    },
    async quoteCart(token, addressUlid) {
      return json<QuoteBreakdown>('/api/v1/cart/quote', authJson(token, 'POST', { addressUlid }));
    },
    async createOrder(token, addressUlid) {
      return json<CreatedOrder>('/api/v1/orders', authJson(token, 'POST', { addressUlid }));
    },
    async payOrder(token, orderUlid, phone, idempotencyKey) {
      return json<Payment>(
        `/api/v1/orders/${orderUlid}/pay`,
        authJson(token, 'POST', { phone }, { 'Idempotency-Key': idempotencyKey }),
      );
    },
    async getOrder(token, orderUlid) {
      return json<OrderDetail>(`/api/v1/orders/${orderUlid}`, auth(token));
    },
    async listOrders(token) {
      const { items } = await json<{ items: OrderSummary[] }>('/api/v1/orders', auth(token));
      return items;
    },
  };
}

/** Flatten a catalogue to a single product list (categorised + uncategorised). Pure helper. */
export function catalogueProducts(catalogue: PublicCatalogue): PublicProduct[] {
  return [...catalogue.categories.flatMap((c) => c.products), ...catalogue.uncategorizedProducts];
}
