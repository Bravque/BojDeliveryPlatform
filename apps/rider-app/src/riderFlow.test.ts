import { describe, expect, it, vi } from 'vitest';
import { createRiderModel } from './riderFlow';
import { ApiError } from './api';
import type { ApiClient, AcceptView, DeliveryView, RiderOfferView } from './api';

const profile = (status: string, vehicleType = 'motorbike') => ({
  status,
  vehicleType,
  isOnline: false,
  payoutPhoneE164: null,
});

const offer = (offerId: number, orderUlid: string): RiderOfferView => ({
  offerId,
  orderUlid,
  expiresAt: '2026-10-25T00:00:10.000Z',
});

const accepted = (orderUlid: string): AcceptView => ({
  orderUlid,
  status: 'rider_assigned',
  deliveryId: 1,
  riderFeeCents: 15_000,
});

const delivery = (deliveryStatus: string): DeliveryView => ({
  orderUlid: 'O1',
  orderStatus: 'out_for_delivery',
  deliveryStatus,
  riderFeeCents: 15_000,
});

function makeApi(over: Partial<ApiClient> = {}): ApiClient {
  return {
    requestOtp: vi.fn(() => Promise.resolve()),
    verifyOtp: vi.fn(() => Promise.resolve({ access: 'tok' })),
    goOnline: vi.fn(() => Promise.resolve()),
    goOffline: vi.fn(() => Promise.resolve()),
    listOffers: vi.fn(() => Promise.resolve([offer(7, 'O1')])),
    acceptOffer: vi.fn(() => Promise.resolve(accepted('O1'))),
    getDelivery: vi.fn(() => Promise.resolve(delivery('assigned'))),
    pickup: vi.fn(() => Promise.resolve(delivery('picked_up'))),
    startDelivery: vi.fn(() => Promise.resolve(delivery('out_for_delivery'))),
    completeDelivery: vi.fn(() => Promise.resolve(delivery('delivered'))),
    getMe: vi.fn(() =>
      Promise.resolve({
        status: 'approved',
        vehicleType: 'motorbike',
        isOnline: true,
        payoutPhoneE164: null,
      }),
    ),
    getEarnings: vi.fn(() => Promise.resolve({ deliveries: 4, totalEarnedCents: 28_000 })),
    setPayoutDestination: vi.fn((_t, phone) =>
      Promise.resolve({
        status: 'approved',
        vehicleType: 'motorbike',
        isOnline: true,
        payoutPhoneE164: phone,
      }),
    ),
    apply: vi.fn((_t, vehicleType) =>
      Promise.resolve({ status: 'pending', vehicleType, isOnline: false, payoutPhoneE164: null }),
    ),
    ping: vi.fn(() => Promise.resolve()),
    declineOffer: vi.fn(() => Promise.resolve()),
    ...over,
  };
}

/** An in-memory token store for exercising session persistence in node (no localStorage). */
function memStore(initial: string | null = null) {
  let token = initial;
  return {
    store: {
      load: () => token,
      save: (t: string) => {
        token = t;
      },
      clear: () => {
        token = null;
      },
    },
    get: () => token,
  };
}

describe('rider flow — critical journey', () => {
  it('phone → OTP → online → accept offer → pickup → start → complete', async () => {
    const api = makeApi();
    const model = createRiderModel(api);

    await model.requestOtp('+254711111111');
    expect(model.getState().screen).toBe('otp');

    await model.verifyOtp('123456');
    expect(model.getState().token).toBe('tok');
    expect(model.getState().screen).toBe('offers');

    await model.goOnline();
    let s = model.getState();
    expect(s.online).toBe(true);
    expect(s.offers.map((o) => o.offerId)).toEqual([7]);

    await model.acceptOffer(7);
    s = model.getState();
    expect(s.screen).toBe('delivery');
    expect(s.delivery?.deliveryStatus).toBe('assigned');
    expect(api.getDelivery).toHaveBeenCalledWith('tok', 'O1');

    await model.pickup();
    expect(model.getState().delivery?.deliveryStatus).toBe('picked_up');

    await model.startDelivery();
    expect(model.getState().delivery?.deliveryStatus).toBe('out_for_delivery');

    await model.complete('1234');
    expect(model.getState().delivery?.deliveryStatus).toBe('delivered');
    expect(api.completeDelivery).toHaveBeenCalledWith('tok', 'O1', '1234');
  });

  it('accept loses the race (409) → error + offers refresh, stays on offers', async () => {
    const api = makeApi({
      acceptOffer: vi.fn(() => Promise.reject(new Error('OFFER_ALREADY_TAKEN'))),
      listOffers: vi
        .fn()
        .mockResolvedValueOnce([offer(7, 'O1')]) // initial online load
        .mockResolvedValueOnce([]), // after the failed accept, offer is gone
    });
    const model = createRiderModel(api);
    await model.verifyOtp('123456');
    await model.goOnline();

    await model.acceptOffer(7);
    const s = model.getState();
    expect(s.error).toBe('Offer already taken');
    expect(s.screen).toBe('offers');
    expect(s.delivery).toBeNull();
    expect(s.offers).toEqual([]);
  });

  it('a rejected PIN keeps the rider on the delivery screen with an error', async () => {
    const api = makeApi({
      completeDelivery: vi.fn(() => Promise.reject(new Error('PIN_INVALID'))),
    });
    const model = createRiderModel(api);
    await model.verifyOtp('123456');
    await model.goOnline();
    await model.acceptOffer(7);

    await model.complete('0000');
    const s = model.getState();
    expect(s.error).toBe('PIN rejected');
    expect(s.screen).toBe('delivery');
    expect(s.delivery?.deliveryStatus).toBe('assigned'); // unchanged
  });

  it('goOffline clears offers; actions require a token', async () => {
    const api = makeApi();
    const model = createRiderModel(api);

    await model.goOnline(); // no token yet
    expect(model.getState().error).toBe('Not signed in');
    expect(api.goOnline).not.toHaveBeenCalled();

    await model.verifyOtp('123456');
    await model.goOnline();
    expect(model.getState().offers).toHaveLength(1);

    await model.goOffline();
    const s = model.getState();
    expect(s.online).toBe(false);
    expect(s.offers).toEqual([]);
  });

  it('onOfferPush silently re-fetches live offers when online', async () => {
    const api = makeApi({
      listOffers: vi
        .fn()
        .mockResolvedValueOnce([offer(7, 'O1')]) // initial online load
        .mockResolvedValueOnce([offer(7, 'O1'), offer(8, 'O2')]), // after the realtime push
    });
    const model = createRiderModel(api);
    await model.verifyOtp('123456');
    await model.goOnline();
    expect(model.getState().offers.map((o) => o.offerId)).toEqual([7]);

    await model.onOfferPush();
    const s = model.getState();
    expect(s.offers.map((o) => o.offerId)).toEqual([7, 8]);
    expect(s.busy).toBe(false);
    expect(s.error).toBeNull();
  });

  it('onOfferPush is a no-op when signed out or offline', async () => {
    const api = makeApi();
    const model = createRiderModel(api);

    await model.onOfferPush(); // signed out
    expect(api.listOffers).not.toHaveBeenCalled();

    await model.verifyOtp('123456'); // signed in but still offline
    await model.onOfferPush();
    expect(api.listOffers).not.toHaveBeenCalled();
  });

  it('tab nav: goToTab switches tabs, Account loads the profile, sign-out resets', async () => {
    const api = makeApi();
    const model = createRiderModel(api);
    await model.verifyOtp('123456');
    expect(model.getState().screen).toBe('offers');

    model.goToTab('delivery');
    expect(model.getState().screen).toBe('delivery');

    model.goToTab('account');
    await new Promise((r) => setTimeout(r, 0)); // loadProfile fires async
    const s = model.getState();
    expect(s.screen).toBe('account');
    expect(api.getMe).toHaveBeenCalled();
    expect(s.me?.vehicleType).toBe('motorbike');

    model.signOut();
    expect(model.getState().screen).toBe('phone');
    expect(model.getState().token).toBeNull();
  });

  it('Account tab loads earnings; setPayoutDestination updates the profile', async () => {
    const api = makeApi();
    const model = createRiderModel(api);
    await model.verifyOtp('123456');

    model.goToTab('account');
    await new Promise((r) => setTimeout(r, 0)); // loadProfile + loadEarnings fire async
    expect(api.getEarnings).toHaveBeenCalledWith('tok');
    expect(model.getState().earnings).toEqual({ deliveries: 4, totalEarnedCents: 28_000 });

    await model.setPayoutDestination('+254712345678');
    expect(api.setPayoutDestination).toHaveBeenCalledWith('tok', '+254712345678');
    expect(model.getState().me?.payoutPhoneE164).toBe('+254712345678');
  });

  it('surfaces an error when saving the payout number fails', async () => {
    const api = makeApi({
      setPayoutDestination: vi.fn(() => Promise.reject(new Error('Request failed: 400'))),
    });
    const model = createRiderModel(api);
    await model.verifyOtp('123456');
    await model.setPayoutDestination('bad');
    expect(model.getState().error).toBe('Could not save your payout number');
  });

  it('persists the token on verify and restores the session on startup', async () => {
    const mem = memStore();
    const model = createRiderModel(makeApi(), mem.store);
    expect(model.getState().screen).toBe('phone');
    await model.verifyOtp('123456');
    expect(mem.get()).toBe('tok'); // saved

    // A fresh model with the same (seeded) store starts signed in on the Shift tab.
    const restored = createRiderModel(makeApi(), memStore('tok').store);
    expect(restored.getState().token).toBe('tok');
    expect(restored.getState().screen).toBe('offers');

    model.signOut();
    expect(mem.get()).toBeNull(); // cleared
  });

  it('routes a signed-in non-rider to apply, then to pending after applying', async () => {
    const api = makeApi({ getMe: vi.fn(() => Promise.reject(new ApiError(404))) });
    const model = createRiderModel(api);
    await model.verifyOtp('123456');
    expect(model.getState().screen).toBe('apply');

    await model.apply('bicycle');
    const s = model.getState();
    expect(api.apply).toHaveBeenCalledWith('tok', 'bicycle');
    expect(s.screen).toBe('pending');
    expect(s.me?.status).toBe('pending');
  });

  it('routes pending/suspended riders to the status screen, approved to Shift', async () => {
    const pending = createRiderModel(
      makeApi({ getMe: vi.fn(() => Promise.resolve(profile('pending'))) }),
    );
    await pending.verifyOtp('1');
    expect(pending.getState().screen).toBe('pending');

    const suspended = createRiderModel(
      makeApi({ getMe: vi.fn(() => Promise.resolve(profile('suspended'))) }),
    );
    await suspended.verifyOtp('1');
    expect(suspended.getState().screen).toBe('pending');

    const approved = createRiderModel(makeApi()); // default getMe → approved
    await approved.verifyOtp('1');
    expect(approved.getState().screen).toBe('offers');
  });

  it('refreshStatus advances a pending rider to Shift once approved', async () => {
    const getMe = vi
      .fn()
      .mockResolvedValueOnce(profile('pending'))
      .mockResolvedValueOnce(profile('approved'));
    const model = createRiderModel(makeApi({ getMe }));
    await model.verifyOtp('1');
    expect(model.getState().screen).toBe('pending');

    await model.refreshStatus();
    expect(model.getState().screen).toBe('offers');
  });

  it('declines an offer → it drops off the live list', async () => {
    const api = makeApi({
      listOffers: vi
        .fn()
        .mockResolvedValueOnce([offer(7, 'O1'), offer(8, 'O2')])
        .mockResolvedValueOnce([offer(8, 'O2')]),
    });
    const model = createRiderModel(api);
    await model.verifyOtp('1');
    await model.goOnline();
    expect(model.getState().offers.map((o) => o.offerId)).toEqual([7, 8]);

    await model.declineOffer(7);
    expect(api.declineOffer).toHaveBeenCalledWith('tok', 7);
    expect(model.getState().offers.map((o) => o.offerId)).toEqual([8]);
  });

  it('pings only while online', async () => {
    const api = makeApi();
    const model = createRiderModel(api);
    await model.verifyOtp('1');

    await model.ping(1, 2); // not online yet → no-op
    expect(api.ping).not.toHaveBeenCalled();

    await model.goOnline();
    await model.ping(-1.0634, 34.4731);
    expect(api.ping).toHaveBeenCalledWith('tok', -1.0634, 34.4731);
  });

  it('notifies subscribers on state changes', async () => {
    const api = makeApi();
    const model = createRiderModel(api);
    const seen: string[] = [];
    const unsub = model.subscribe((s) => seen.push(s.screen));
    await model.requestOtp('+254711111111');
    unsub();
    expect(seen).toContain('otp');
  });
});
