/**
 * Thin typed REST client for the merchant dashboard. The canonical state always comes from here —
 * realtime events are only nudges to re-fetch (doc 02 §4). (An OpenAPI-generated `packages/api-client`
 * shared by all frontends is deferred to the broader client-apps track.)
 */
export interface OrderSummary {
  ulid: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  totalCents: number;
  createdAt: string;
}

export interface MerchantOrders {
  merchant: { ulid: string; name: string };
  orders: OrderSummary[];
}

export interface LoginResult {
  access: string;
}

export interface ApiClient {
  login(email: string, password: string): Promise<LoginResult>;
  listMerchantOrders(token: string): Promise<MerchantOrders>;
  acceptOrder(token: string, orderUlid: string): Promise<void>;
  startPreparing(token: string, orderUlid: string): Promise<void>;
  markReady(token: string, orderUlid: string): Promise<void>;
}

export function createHttpApiClient(baseUrl: string): ApiClient {
  async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  return {
    async login(email, password) {
      return post<LoginResult>('/api/v1/auth/password/login', { email, password });
    },
    async listMerchantOrders(token) {
      const res = await fetch(`${baseUrl}/api/v1/merchant/orders`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(`Request failed: ${res.status}`);
      }
      return (await res.json()) as MerchantOrders;
    },
    async acceptOrder(token, orderUlid) {
      await post(`/api/v1/merchant/orders/${orderUlid}/accept`, {}, token);
    },
    async startPreparing(token, orderUlid) {
      await post(`/api/v1/merchant/orders/${orderUlid}/preparing`, {}, token);
    },
    async markReady(token, orderUlid) {
      await post(`/api/v1/merchant/orders/${orderUlid}/ready`, {}, token);
    },
  };
}
