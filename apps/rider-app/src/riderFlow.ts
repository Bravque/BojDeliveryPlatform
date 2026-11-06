/**
 * Headless controller for the rider critical journey — phone-OTP sign-in → go online → see live
 * offers → accept one (first-wins) → pickup → start → complete with the customer's PIN. All state
 * transitions and API orchestration live here (business logic out of UI), so the whole journey is
 * unit-tested in CI without a React Native runtime. `App.tsx` is a thin view over `getState()`.
 */
import type { ApiClient, DeliveryView, RiderOfferView, RiderProfile } from './api';

/** The three bottom-nav tabs. */
export type Tab = 'offers' | 'delivery' | 'account';

export type Screen = 'phone' | 'otp' | Tab;

/** Whether a screen is a bottom-nav tab (so the tab bar shows there). */
export const TABS: Tab[] = ['offers', 'delivery', 'account'];
export function isTab(screen: Screen): screen is Tab {
  return (TABS as string[]).includes(screen);
}

export interface RiderState {
  screen: Screen;
  token: string | null;
  phone: string;
  online: boolean;
  offers: RiderOfferView[];
  delivery: DeliveryView | null;
  me: RiderProfile | null;
  error: string | null;
  busy: boolean;
}

export function initialState(): RiderState {
  return {
    screen: 'phone',
    token: null,
    phone: '',
    online: false,
    offers: [],
    delivery: null,
    me: null,
    error: null,
    busy: false,
  };
}

export interface RiderModel {
  getState(): RiderState;
  subscribe(listener: (s: RiderState) => void): () => void;
  requestOtp(phone: string): Promise<void>;
  verifyOtp(code: string): Promise<void>;
  goOnline(): Promise<void>;
  goOffline(): Promise<void>;
  refreshOffers(): Promise<void>;
  /** Silent re-fetch on a realtime `offer.new` push (no busy/error toggling — notifications only). */
  onOfferPush(): Promise<void>;
  acceptOffer(offerId: number): Promise<void>;
  pickup(): Promise<void>;
  startDelivery(): Promise<void>;
  complete(pin: string): Promise<void>;
  /** Switch bottom-nav tab (loads the profile on the Account tab). */
  goToTab(tab: Tab): void;
  /** Re-fetch the rider profile (Account tab). */
  loadProfile(): Promise<void>;
  /** Clear the session and return to sign-in. */
  signOut(): void;
  backToOffers(): void;
}

export function createRiderModel(api: ApiClient): RiderModel {
  let state = initialState();
  const listeners = new Set<(s: RiderState) => void>();

  function set(patch: Partial<RiderState>): void {
    state = { ...state, ...patch };
    for (const l of listeners) {
      l(state);
    }
  }

  /** Run an async op with busy/error bookkeeping; `op` resolves the success patch. */
  async function run(op: () => Promise<Partial<RiderState>>, failMsg: string): Promise<void> {
    set({ busy: true, error: null });
    try {
      const patch = await op();
      set({ ...patch, busy: false });
    } catch {
      set({ busy: false, error: failMsg });
    }
  }

  function requireToken(): string | null {
    if (!state.token) {
      set({ error: 'Not signed in' });
      return null;
    }
    return state.token;
  }

  async function loadProfile(): Promise<void> {
    const token = state.token;
    if (!token) {
      return;
    }
    await run(async () => ({ me: await api.getMe(token) }), 'Could not load your profile');
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
        return { token: access, screen: 'offers' };
      }, 'Invalid code');
    },

    async goOnline() {
      const token = requireToken();
      if (!token) {
        return;
      }
      await run(async () => {
        await api.goOnline(token);
        const offers = await api.listOffers(token);
        return { online: true, offers };
      }, 'Could not go online');
    },

    async goOffline() {
      const token = requireToken();
      if (!token) {
        return;
      }
      await run(async () => {
        await api.goOffline(token);
        return { online: false, offers: [] };
      }, 'Could not go offline');
    },

    async refreshOffers() {
      const token = requireToken();
      if (!token) {
        return;
      }
      await run(async () => ({ offers: await api.listOffers(token) }), 'Could not load offers');
    },

    async onOfferPush() {
      // Only meaningful while signed in and online; stay quiet (no busy/error) like the push it is.
      if (!state.token || !state.online) {
        return;
      }
      try {
        set({ offers: await api.listOffers(state.token) });
      } catch {
        // A failed nudge-refresh keeps the current offers; the next push or manual refresh retries.
      }
    },

    async acceptOffer(offerId) {
      const token = requireToken();
      if (!token) {
        return;
      }
      set({ busy: true, error: null });
      try {
        const accepted = await api.acceptOffer(token, offerId);
        const delivery = await api.getDelivery(token, accepted.orderUlid);
        set({ delivery, screen: 'delivery', busy: false });
      } catch {
        // First-wins: another rider likely took it. Surface it and refresh the live offers.
        set({ busy: false, error: 'Offer already taken' });
        try {
          set({ offers: await api.listOffers(token) });
        } catch {
          // ignore a refresh failure — the next manual refresh retries
        }
      }
    },

    async pickup() {
      const token = requireToken();
      if (!token || !state.delivery) {
        return;
      }
      const ulid = state.delivery.orderUlid;
      await run(
        async () => ({ delivery: await api.pickup(token, ulid) }),
        'Could not confirm pickup',
      );
    },

    async startDelivery() {
      const token = requireToken();
      if (!token || !state.delivery) {
        return;
      }
      const ulid = state.delivery.orderUlid;
      await run(
        async () => ({ delivery: await api.startDelivery(token, ulid) }),
        'Could not start delivery',
      );
    },

    async complete(pin) {
      const token = requireToken();
      if (!token || !state.delivery) {
        return;
      }
      const ulid = state.delivery.orderUlid;
      await run(
        async () => ({ delivery: await api.completeDelivery(token, ulid, pin) }),
        'PIN rejected',
      );
    },

    goToTab(tab) {
      set({ screen: tab, error: null });
      if (tab === 'account') {
        void loadProfile();
      }
    },

    loadProfile,

    signOut() {
      set(initialState());
    },

    backToOffers() {
      set({ screen: 'offers', delivery: null, error: null });
    },
  };
}
