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

// ---- catalogue (menu management) ------------------------------------------------------------
export interface ManagedOption {
  ulid: string;
  name: string;
  priceDeltaCents: number;
  isAvailable: boolean;
}

export interface ManagedOptionGroup {
  ulid: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: ManagedOption[];
}

export interface ManagedInventory {
  trackStock: boolean;
  quantity: number;
  reserved: number;
}

export interface ManagedProduct {
  ulid: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  isAvailable: boolean;
  version: number;
  categoryUlid: string | null;
  inventory: ManagedInventory | null;
  optionGroups: ManagedOptionGroup[];
}

export interface ManagedCategory {
  ulid: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface MerchantCatalogue {
  merchant: { ulid: string };
  categories: ManagedCategory[];
  products: ManagedProduct[];
}

export interface ProductSummary {
  ulid: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  isAvailable: boolean;
  version: number;
}

/** The create-option-group response (no nested options yet — the UI re-fetches the catalogue). */
export interface OptionGroupSummary {
  ulid: string;
  name: string;
  minSelect: number;
  maxSelect: number;
}

/** Public merchant profile (GET /merchants/:ulid) — the source of the current open/prep-time state. */
export interface PublicMerchant {
  ulid: string;
  name: string;
  categoryType: string;
  prepMinutes: number;
  isOpen: boolean;
  townName: string;
}

/** One merchant settlement (earnings), from GET /merchant/settlements. */
export interface SettlementView {
  ulid: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  commissionCents: number;
  refundsCents: number;
  netCents: number;
  status: string;
}

export interface LoginResult {
  access: string;
}

/** Error carrying the HTTP status + the server's `{ error: { code, message } }` envelope. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code?: string,
    message?: string,
  ) {
    super(message ?? `Request failed: ${status}`);
    this.name = 'ApiError';
  }
}

export interface ApiClient {
  login(email: string, password: string): Promise<LoginResult>;
  listMerchantOrders(token: string): Promise<MerchantOrders>;
  getMerchantOrder(token: string, orderUlid: string): Promise<MerchantOrderDetail>;
  acceptOrder(token: string, orderUlid: string): Promise<void>;
  startPreparing(token: string, orderUlid: string): Promise<void>;
  markReady(token: string, orderUlid: string): Promise<void>;
  rejectOrder(token: string, orderUlid: string, reason: string): Promise<void>;

  getCatalogue(token: string): Promise<MerchantCatalogue>;
  createCategory(
    token: string,
    input: { name: string; sortOrder?: number },
  ): Promise<ManagedCategory>;
  createProduct(
    token: string,
    input: { name: string; description?: string; priceCents: number; categoryUlid?: string },
  ): Promise<ProductSummary>;
  editProduct(
    token: string,
    ulid: string,
    input: {
      expectedVersion: number;
      name?: string;
      description?: string | null;
      priceCents?: number;
      categoryUlid?: string;
    },
  ): Promise<ProductSummary>;
  setProductAvailability(
    token: string,
    ulid: string,
    isAvailable: boolean,
  ): Promise<ProductSummary>;
  setInventory(
    token: string,
    ulid: string,
    input: { trackStock: boolean; quantity: number },
  ): Promise<ManagedInventory>;
  addOptionGroup(
    token: string,
    productUlid: string,
    input: { name: string; minSelect: number; maxSelect: number },
  ): Promise<OptionGroupSummary>;
  addOption(
    token: string,
    groupUlid: string,
    input: { name: string; priceDeltaCents: number; isAvailable?: boolean },
  ): Promise<ManagedOption>;
  setOptionAvailability(
    token: string,
    optionUlid: string,
    isAvailable: boolean,
  ): Promise<{ ulid: string; isAvailable: boolean }>;

  getPublicMerchant(ulid: string): Promise<PublicMerchant>;
  updateProfile(
    token: string,
    patch: { isOpen?: boolean; prepMinutes?: number },
  ): Promise<{ merchantUlid: string }>;
  listSettlements(token: string): Promise<SettlementView[]>;
}

export function createHttpApiClient(baseUrl: string): ApiClient {
  async function request<T>(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    if (!res.ok) {
      let code: string | undefined;
      let message: string | undefined;
      try {
        const parsed = (await res.json()) as { error?: { code?: string; message?: string } };
        code = parsed.error?.code;
        message = parsed.error?.message;
      } catch {
        // non-JSON error body — fall back to the status
      }
      throw new ApiError(res.status, code, message);
    }
    // Some endpoints (actions) return a body we ignore; parse defensively.
    return (await res.json().catch(() => ({}))) as T;
  }

  return {
    login(email, password) {
      return request<LoginResult>('POST', '/api/v1/auth/password/login', {
        body: { email, password },
      });
    },
    listMerchantOrders(token) {
      return request<MerchantOrders>('GET', '/api/v1/merchant/orders', { token });
    },
    getMerchantOrder(token, orderUlid) {
      return request<MerchantOrderDetail>('GET', `/api/v1/merchant/orders/${orderUlid}`, { token });
    },
    async acceptOrder(token, orderUlid) {
      await request('POST', `/api/v1/merchant/orders/${orderUlid}/accept`, { token, body: {} });
    },
    async startPreparing(token, orderUlid) {
      await request('POST', `/api/v1/merchant/orders/${orderUlid}/preparing`, { token, body: {} });
    },
    async markReady(token, orderUlid) {
      await request('POST', `/api/v1/merchant/orders/${orderUlid}/ready`, { token, body: {} });
    },
    async rejectOrder(token, orderUlid, reason) {
      await request('POST', `/api/v1/merchant/orders/${orderUlid}/reject`, {
        token,
        body: { reason },
      });
    },

    getCatalogue(token) {
      return request<MerchantCatalogue>('GET', '/api/v1/merchant/catalogue', { token });
    },
    createCategory(token, input) {
      return request<ManagedCategory>('POST', '/api/v1/merchant/catalogue/categories', {
        token,
        body: input,
      });
    },
    createProduct(token, input) {
      return request<ProductSummary>('POST', '/api/v1/merchant/catalogue/products', {
        token,
        body: input,
      });
    },
    editProduct(token, ulid, input) {
      return request<ProductSummary>('PATCH', `/api/v1/merchant/catalogue/products/${ulid}`, {
        token,
        body: input,
      });
    },
    setProductAvailability(token, ulid, isAvailable) {
      return request<ProductSummary>(
        'PATCH',
        `/api/v1/merchant/catalogue/products/${ulid}/availability`,
        { token, body: { isAvailable } },
      );
    },
    setInventory(token, ulid, input) {
      return request<ManagedInventory>(
        'PUT',
        `/api/v1/merchant/catalogue/products/${ulid}/inventory`,
        { token, body: input },
      );
    },
    addOptionGroup(token, productUlid, input) {
      return request<OptionGroupSummary>(
        'POST',
        `/api/v1/merchant/catalogue/products/${productUlid}/option-groups`,
        { token, body: input },
      );
    },
    addOption(token, groupUlid, input) {
      return request<ManagedOption>(
        'POST',
        `/api/v1/merchant/catalogue/option-groups/${groupUlid}/options`,
        { token, body: input },
      );
    },
    setOptionAvailability(token, optionUlid, isAvailable) {
      return request<{ ulid: string; isAvailable: boolean }>(
        'PATCH',
        `/api/v1/merchant/catalogue/options/${optionUlid}/availability`,
        { token, body: { isAvailable } },
      );
    },

    getPublicMerchant(ulid) {
      return request<PublicMerchant>('GET', `/api/v1/merchants/${ulid}`);
    },
    updateProfile(token, patch) {
      return request<{ merchantUlid: string }>('PATCH', '/api/v1/merchant/profile', {
        token,
        body: patch,
      });
    },
    async listSettlements(token) {
      const res = await request<{ items: SettlementView[] }>(
        'GET',
        '/api/v1/merchant/settlements',
        { token },
      );
      return res.items;
    },
  };
}
