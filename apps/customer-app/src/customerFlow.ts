/**
 * Headless controller for the customer critical journey — phone-OTP sign-in → browse merchants →
 * open a merchant menu → build a basket → checkout (authoritative quote → place order → initiate
 * M-Pesa payment) → track the order live. All state transitions and API orchestration live here
 * (business logic out of UI, per CLAUDE.md), so the whole journey is unit-tested in CI without a
 * React Native runtime. `App.tsx` is a thin view that renders `getState()` and calls these methods.
 */
import type {
  ApiClient,
  AddressSummary,
  OrderDetail,
  OrderSummary,
  PublicCatalogue,
  PublicMerchant,
  PublicProduct,
  QuoteBreakdown,
} from './api';

/** The five bottom-nav tabs. */
export type Tab = 'home' | 'stores' | 'search' | 'orders' | 'account';

export type Screen = 'phone' | 'otp' | Tab | 'merchant' | 'checkout' | 'track';

/** Whether a screen is a bottom-nav tab (so the tab bar shows there). */
export const TABS: Tab[] = ['home', 'stores', 'search', 'orders', 'account'];
export function isTab(screen: Screen): screen is Tab {
  return (TABS as string[]).includes(screen);
}

/** One line in the (client-side) basket; the server cart is the source of truth for pricing. */
export interface BasketLine {
  productUlid: string;
  name: string;
  priceCents: number;
  currency: string;
  qty: number;
}

export interface CustomerState {
  screen: Screen;
  token: string | null;
  phone: string;
  merchants: PublicMerchant[];
  catalogue: PublicCatalogue | null;
  basket: BasketLine[];
  quote: QuoteBreakdown | null;
  address: AddressSummary | null;
  orders: OrderSummary[];
  order: OrderDetail | null;
  error: string | null;
  busy: boolean;
}

// The Migori CBD zone centre — used as a sensible default delivery point when the signed-in
// customer has no saved address yet (keeps checkout in-zone for the MVP; a full address picker
// is a future enhancement).
const DEFAULT_LAT = -1.0634;
const DEFAULT_LNG = 34.4731;

export function initialState(): CustomerState {
  return {
    screen: 'phone',
    token: null,
    phone: '',
    merchants: [],
    catalogue: null,
    basket: [],
    quote: null,
    address: null,
    orders: [],
    order: null,
    error: null,
    busy: false,
  };
}

export interface CustomerModel {
  getState(): CustomerState;
  subscribe(listener: (s: CustomerState) => void): () => void;
  requestOtp(phone: string): Promise<void>;
  verifyOtp(code: string): Promise<void>;
  loadMerchants(townName?: string): Promise<void>;
  /** Switch bottom-nav tab (loads the order history when moving to the Orders tab). */
  goToTab(tab: Tab): void;
  /** Re-fetch the customer's order history (Orders tab). */
  loadOrders(): Promise<void>;
  /** Clear the session and return to sign-in. */
  signOut(): void;
  openMerchant(merchantUlid: string): Promise<void>;
  addToBasket(product: PublicProduct): Promise<void>;
  /** Resolve a delivery address + fetch the authoritative quote, then show checkout. */
  openCheckout(): Promise<void>;
  /** Create the order, initiate M-Pesa payment, and jump to live tracking (status: pending). */
  placeOrder(): Promise<void>;
  trackOrder(orderUlid: string): Promise<void>;
  /** Re-fetch the currently tracked order (called on a realtime nudge — notifications only). */
  refreshOrder(): Promise<void>;
  /** Return to the merchant menu from checkout, keeping the basket. */
  backToMenu(): void;
  backToBrowse(): void;
}

function randomKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createCustomerModel(api: ApiClient): CustomerModel {
  let state = initialState();
  const listeners = new Set<(s: CustomerState) => void>();

  function set(patch: Partial<CustomerState>): void {
    state = { ...state, ...patch };
    for (const l of listeners) {
      l(state);
    }
  }

  /** Run an async op with busy/error bookkeeping; `onOk` applies the success patch. */
  async function run(op: () => Promise<Partial<CustomerState>>, failMsg: string): Promise<void> {
    set({ busy: true, error: null });
    try {
      const patch = await op();
      set({ ...patch, busy: false });
    } catch {
      set({ busy: false, error: failMsg });
    }
  }

  async function loadOrders(): Promise<void> {
    const token = state.token;
    if (!token) {
      return;
    }
    await run(async () => ({ orders: await api.listOrders(token) }), 'Could not load your orders');
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async requestOtp(phone) {
      await run(async () => {
        await api.requestOtp(phone);
        return { phone, screen: 'otp' };
      }, 'Could not send code');
    },

    async verifyOtp(code) {
      await run(async () => {
        const { access } = await api.verifyOtp(state.phone, code);
        const merchants = await api.listMerchants();
        return { token: access, merchants, screen: 'home' };
      }, 'Invalid code');
    },

    async loadMerchants(townName) {
      await run(async () => {
        const merchants = await api.listMerchants(townName);
        return { merchants, screen: 'home' };
      }, 'Could not load merchants');
    },

    goToTab(tab) {
      set({ screen: tab, error: null });
      if (tab === 'orders') {
        void loadOrders();
      }
    },

    loadOrders,

    signOut() {
      set(initialState());
    },

    async openMerchant(merchantUlid) {
      await run(async () => {
        const catalogue = await api.getCatalogue(merchantUlid);
        // Start a clean basket for this merchant (the server cart is single-merchant).
        if (state.token) {
          try {
            await api.clearCart(state.token);
          } catch {
            // best-effort; a stale cart surfaces as an error at checkout instead
          }
        }
        return { catalogue, basket: [], quote: null, screen: 'merchant' };
      }, 'Could not load menu');
    },

    async addToBasket(product) {
      const token = state.token;
      if (!token) {
        set({ error: 'Not signed in' });
        return;
      }
      const prev = state.basket;
      const existing = prev.find((b) => b.productUlid === product.ulid);
      const basket = existing
        ? prev.map((b) => (b.productUlid === product.ulid ? { ...b, qty: b.qty + 1 } : b))
        : [
            ...prev,
            {
              productUlid: product.ulid,
              name: product.name,
              priceCents: product.priceCents,
              currency: product.currency,
              qty: 1,
            },
          ];
      set({ basket, error: null });
      try {
        await api.addToCart(token, product.ulid, 1);
      } catch {
        set({ basket: prev, error: 'Could not add to basket' });
      }
    },

    async openCheckout() {
      const token = state.token;
      if (!token || state.basket.length === 0) {
        return;
      }
      await run(async () => {
        const existing = await api.listAddresses(token);
        const address =
          existing.find((a) => a.serviceable) ??
          (await api.createAddress(token, {
            line1: 'My location, Migori CBD',
            lat: DEFAULT_LAT,
            lng: DEFAULT_LNG,
            label: 'Home',
          }));
        const quote = await api.quoteCart(token, address.ulid);
        return { address, quote, screen: 'checkout' };
      }, 'Could not start checkout');
    },

    async placeOrder() {
      const token = state.token;
      const address = state.address;
      if (!token || !address) {
        set({ error: 'Not signed in' });
        return;
      }
      await run(async () => {
        const created = await api.createOrder(token, address.ulid);
        // Initiate the M-Pesa STK push — the order stays payment_pending until the callback
        // confirms capture (verified server-side; the tracker reflects it live).
        await api.payOrder(token, created.ulid, state.phone, randomKey());
        const order = await api.getOrder(token, created.ulid);
        return { order, basket: [], quote: null, screen: 'track' };
      }, 'Could not place order');
    },

    async trackOrder(orderUlid) {
      if (!state.token) {
        set({ error: 'Not signed in' });
        return;
      }
      await run(async () => {
        const order = await api.getOrder(state.token!, orderUlid);
        return { order, screen: 'track' };
      }, 'Could not load order');
    },

    async refreshOrder() {
      if (!state.token || !state.order) {
        return;
      }
      const ulid = state.order.ulid;
      try {
        const order = await api.getOrder(state.token, ulid);
        set({ order });
      } catch {
        // A failed nudge-refresh keeps the last known order; the next nudge retries.
      }
    },

    backToMenu() {
      set({ screen: 'merchant', error: null });
    },

    backToBrowse() {
      set({ screen: 'home', catalogue: null, basket: [], quote: null, order: null, error: null });
    },
  };
}
