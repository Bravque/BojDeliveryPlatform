import { describe, expect, it, vi } from 'vitest';
import { createRiderModel } from './riderFlow';
import type { ApiClient, AcceptView, DeliveryView, RiderOfferView } from './api';

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
    ...over,
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
