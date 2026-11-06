/**
 * Headless controller for the rider critical journey — phone-OTP sign-in → go online → see live
 * offers → accept one (first-wins) → pickup → start → complete with the customer's PIN. All state
 * transitions and API orchestration live here (business logic out of UI), so the whole journey is
 * unit-tested in CI without a React Native runtime. `App.tsx` is a thin view over `getState()`.
 */
import {
  ApiError,
  type ApiClient,
  type DeliveryView,
  type RiderEarnings,
  type RiderOfferView,
  type RiderProfile,
  type VehicleType,
} from './api';
import { webTokenStore, type TokenStore } from './storage';

/** The three bottom-nav tabs. */
export type Tab = 'offers' | 'delivery' | 'account';

/** `apply`/`pending` are the onboarding screens shown before a rider is approved (no tab bar). */
export type Screen = 'phone' | 'otp' | 'apply' | 'pending' | Tab;

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
  earnings: RiderEarnings | null;
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
    earnings: null,
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
  /** Decline an offer → it drops off the live list. */
  declineOffer(offerId: number): Promise<void>;
  /** Submit a rider application (for a signed-in user who isn't a rider yet) → pending. */
  apply(vehicleType: VehicleType): Promise<void>;
  /** Best-effort presence ping while online (keeps the rider a fresh offer candidate). */
  ping(lat: number, lng: number): Promise<void>;
  /** Re-check the rider profile/status (pending screen) — advances to Shift once approved. */
  refreshStatus(): Promise<void>;
  pickup(): Promise<void>;
  startDelivery(): Promise<void>;
  complete(pin: string): Promise<void>;
  /** Switch bottom-nav tab (loads the profile + earnings on the Account tab). */
  goToTab(tab: Tab): void;
  /** Re-fetch the rider profile (Account tab). */
  loadProfile(): Promise<void>;
  /** Re-fetch lifetime earnings (Account tab). */
  loadEarnings(): Promise<void>;
  /** Set the rider's M-Pesa withdrawal number; updates the profile on success. */
  setPayoutDestination(phone: string): Promise<void>;
  /** Clear the session and return to sign-in. */
  signOut(): void;
  backToOffers(): void;
}

export function createRiderModel(api: ApiClient, store: TokenStore = webTokenStore): RiderModel {
  // Restore a persisted session on startup: a stored token lands the rider straight on the Shift tab
  // (token validity is checked lazily — a stale token just errors on the next action).
  const persisted = store.load();
  let state: RiderState = persisted
    ? { ...initialState(), token: persisted, screen: 'offers' }
    : initialState();
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

  async function loadEarnings(): Promise<void> {
    const token = state.token;
    if (!token) {
      return;
    }
    await run(
      async () => ({ earnings: await api.getEarnings(token) }),
      'Could not load your earnings',
    );
  }

  /**
   * Route to the right screen after sign-in / on restore by looking up the rider profile:
   * approved → Shift (offers); pending/suspended → the status screen; no profile (404) → apply.
   */
  async function resolveSession(token: string): Promise<void> {
    try {
      const me = await api.getMe(token);
      set({ me, screen: me.status === 'approved' ? 'offers' : 'pending', busy: false });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        set({ me: null, screen: 'apply', busy: false });
      } else {
        set({ busy: false, error: 'Could not load your rider profile' });
      }
    }
  }

  // Restored session: confirm the rider's current status (may correct the optimistic Shift screen).
  if (persisted) {
    void resolveSession(persisted);
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
      set({ busy: true, error: null });
      try {
        const { access } = await api.verifyOtp(state.phone, code);
        store.save(access);
        set({ token: access });
        await resolveSession(access); // route to offers / pending / apply by profile
      } catch {
        set({ busy: false, error: 'Invalid code' });
      }
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

    async declineOffer(offerId) {
      const token = requireToken();
      if (!token) {
        return;
      }
      await run(async () => {
        await api.declineOffer(token, offerId);
        return { offers: await api.listOffers(token) };
      }, 'Could not decline the offer');
    },

    async apply(vehicleType) {
      const token = requireToken();
      if (!token) {
        return;
      }
      await run(async () => {
        const me = await api.apply(token, vehicleType);
        return { me, screen: 'pending' };
      }, 'Could not submit your application');
    },

    async ping(lat, lng) {
      const token = state.token;
      if (!token || !state.online) {
        return;
      }
      try {
        await api.ping(token, lat, lng);
      } catch {
        // Best-effort presence — a failed ping is retried on the next interval.
      }
    },

    async refreshStatus() {
      const token = requireToken();
      if (!token) {
        return;
      }
      set({ busy: true, error: null });
      await resolveSession(token);
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
        void loadEarnings();
      }
    },

    loadProfile,
    loadEarnings,

    async setPayoutDestination(phone) {
      const token = requireToken();
      if (!token) {
        return;
      }
      await run(
        async () => ({ me: await api.setPayoutDestination(token, phone) }),
        'Could not save your payout number',
      );
    },

    signOut() {
      store.clear();
      set(initialState());
    },

    backToOffers() {
      set({ screen: 'offers', delivery: null, error: null });
    },
  };
}
