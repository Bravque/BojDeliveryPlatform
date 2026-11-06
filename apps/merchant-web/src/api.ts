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

export interface MerchantOrderItemOption {
  name: string;
  priceDeltaCents: number;
}

export interface MerchantOrderItem {
  productUlid: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
  options: MerchantOrderItemOption[];
}

/** One order's full detail (line items + money breakdown), from GET /merchant/orders/:ulid. */
export interface MerchantOrderDetail {
  ulid: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  currency: string;
  items: MerchantOrderItem[];
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  discountCents: number;
  commissionCents: number;
  totalCents: number;
  createdAt: string;
}

export interface LoginResult {
  access: string;
}

export interface ApiClient {
  login(email: string, password: string): Promise<LoginResult>;
  listMerchantOrders(token: string): Promise<MerchantOrders>;
  getMerchantOrder(token: string, orderUlid: string): Promise<MerchantOrderDetail>;
  acceptOrder(token: string, orderUlid: string): Promise<void>;
  startPreparing(token: string, orderUlid: string): Promise<void>;
  markReady(token: string, orderUlid: string): Promise<void>;
  rejectOrder(token: string, orderUlid: string, reason: string): Promise<void>;
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

  async function get<T>(path: string, token: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
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
      return get<MerchantOrders>('/api/v1/merchant/orders', token);
    },
    async getMerchantOrder(token, orderUlid) {
      return get<MerchantOrderDetail>(`/api/v1/merchant/orders/${orderUlid}`, token);
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
    async rejectOrder(token, orderUlid, reason) {
      await post(`/api/v1/merchant/orders/${orderUlid}/reject`, { reason }, token);
    },
  };
}
