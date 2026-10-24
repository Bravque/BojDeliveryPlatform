/**
 * Thin typed REST client for the customer app. Pure (uses the global `fetch` that both Node and
 * React Native provide), so it is unit-tested in CI without a native runtime. Types mirror the
 * server DTOs (`auth/*`, `browse/service.ts`, `orders/*`). Canonical state always comes from
 * here; realtime is only a nudge to re-fetch (doc 02 §4).
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

/** Minimal order view for tracking (`GET /orders/:ulid`). */
export interface OrderDetail {
  ulid: string;
  orderNumber: string;
  status: string;
  paymentStatus?: string;
  totalCents?: number;
}

export interface ApiClient {
  requestOtp(phone: string): Promise<void>;
  verifyOtp(phone: string, code: string): Promise<AuthResult>;
  listMerchants(townName?: string): Promise<PublicMerchant[]>;
  getCatalogue(merchantUlid: string): Promise<PublicCatalogue>;
  getOrder(token: string, orderUlid: string): Promise<OrderDetail>;
}

export function createHttpApiClient(baseUrl: string): ApiClient {
  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) {
      throw new Error(`Request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  function postJson(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
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
    async getOrder(token, orderUlid) {
      return json<OrderDetail>(`/api/v1/orders/${orderUlid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    },
  };
}

/** Flatten a catalogue to a single product list (categorised + uncategorised). Pure helper. */
export function catalogueProducts(catalogue: PublicCatalogue): PublicProduct[] {
  return [...catalogue.categories.flatMap((c) => c.products), ...catalogue.uncategorizedProducts];
}
