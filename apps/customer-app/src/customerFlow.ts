/**
 * Headless controller for the customer critical journey — phone-OTP sign-in → browse merchants →
 * open a merchant catalogue → track an order. All state transitions and API orchestration live
 * here (business logic out of UI, per CLAUDE.md), so the whole journey is unit-tested in CI
 * without a React Native runtime. `App.tsx` is a thin view that renders `getState()` and calls
 * these methods.
 */
import type { ApiClient, OrderDetail, PublicCatalogue, PublicMerchant } from './api';

export type Screen = 'phone' | 'otp' | 'browse' | 'merchant' | 'track';

export interface CustomerState {
  screen: Screen;
  token: string | null;
  phone: string;
  merchants: PublicMerchant[];
  catalogue: PublicCatalogue | null;
  order: OrderDetail | null;
  error: string | null;
  busy: boolean;
}

export function initialState(): CustomerState {
  return {
    screen: 'phone',
    token: null,
    phone: '',
    merchants: [],
    catalogue: null,
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
  openMerchant(merchantUlid: string): Promise<void>;
  trackOrder(orderUlid: string): Promise<void>;
  /** Re-fetch the currently tracked order (called on a realtime nudge — notifications only). */
  refreshOrder(): Promise<void>;
  backToBrowse(): void;
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
        return { token: access, merchants, screen: 'browse' };
      }, 'Invalid code');
    },

    async loadMerchants(townName) {
      await run(async () => {
        const merchants = await api.listMerchants(townName);
        return { merchants, screen: 'browse' };
      }, 'Could not load merchants');
    },

    async openMerchant(merchantUlid) {
      await run(async () => {
        const catalogue = await api.getCatalogue(merchantUlid);
        return { catalogue, screen: 'merchant' };
      }, 'Could not load menu');
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

    backToBrowse() {
      set({ screen: 'browse', catalogue: null, order: null, error: null });
    },
  };
}
