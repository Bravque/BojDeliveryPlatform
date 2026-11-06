/**
 * Thin typed REST client for the rider app. Pure (global `fetch`), so it is unit-tested in CI
 * without a native runtime. Types mirror the server DTOs (`auth/*`, `delivery/assignment-service.ts`,
 * `delivery/delivery-service.ts`). Canonical state always comes from here.
 */

export interface AuthResult {
  access: string;
}

export type VehicleType = 'motorbike' | 'bicycle' | 'car' | 'foot';

/** Error carrying the HTTP status, so callers can branch (e.g. 404 = not a rider yet → apply). */
export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`Request failed: ${status}`);
    this.name = 'ApiError';
  }
}

/** Mirrors `RiderOfferView` (`GET /rider/offers`). */
export interface RiderOfferView {
  offerId: number;
  orderUlid: string;
  expiresAt: string;
}

/** Mirrors `AcceptView` (`POST /rider/offers/:id/accept`). */
export interface AcceptView {
  orderUlid: string;
  status: string;
  deliveryId: number;
  riderFeeCents: number;
}

/** Mirrors `DeliveryView` (delivery reads + pickup/start/complete). */
export interface DeliveryView {
  orderUlid: string;
  orderStatus: string;
  deliveryStatus: string;
  riderFeeCents: number;
}

/** Mirrors the rider profile (`GET /rider/me`). */
export interface RiderProfile {
  status: string;
  vehicleType: string;
  isOnline: boolean;
  /** M-Pesa withdrawal destination; null = earnings pay out to the sign-in number. */
  payoutPhoneE164: string | null;
}

/** Mirrors `RiderEarnings` (`GET /rider/earnings`). */
export interface RiderEarnings {
  deliveries: number;
  totalEarnedCents: number;
}

export interface ApiClient {
  requestOtp(phone: string): Promise<void>;
  verifyOtp(phone: string, code: string): Promise<AuthResult>;
  goOnline(token: string): Promise<void>;
  goOffline(token: string): Promise<void>;
  listOffers(token: string): Promise<RiderOfferView[]>;
  acceptOffer(token: string, offerId: number): Promise<AcceptView>;
  getDelivery(token: string, orderUlid: string): Promise<DeliveryView>;
  pickup(token: string, orderUlid: string): Promise<DeliveryView>;
  startDelivery(token: string, orderUlid: string): Promise<DeliveryView>;
  completeDelivery(token: string, orderUlid: string, pin: string): Promise<DeliveryView>;
  getMe(token: string): Promise<RiderProfile>;
  getEarnings(token: string): Promise<RiderEarnings>;
  setPayoutDestination(token: string, phone: string): Promise<RiderProfile>;
  apply(token: string, vehicleType: VehicleType): Promise<RiderProfile>;
  ping(token: string, lat: number, lng: number): Promise<void>;
  declineOffer(token: string, offerId: number): Promise<void>;
}

export function createHttpApiClient(baseUrl: string): ApiClient {
  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) {
      throw new ApiError(res.status);
    }
    return (await res.json()) as T;
  }

  function post(token: string | undefined, body?: unknown): RequestInit {
    return {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    };
  }

  function auth(token: string): RequestInit {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  return {
    async requestOtp(phone) {
      await json('/api/v1/auth/otp/request', post(undefined, { phone }));
    },
    async verifyOtp(phone, code) {
      return json<AuthResult>('/api/v1/auth/otp/verify', post(undefined, { phone, code }));
    },
    async goOnline(token) {
      await json('/api/v1/rider/online', post(token));
    },
    async goOffline(token) {
      await json('/api/v1/rider/offline', post(token));
    },
    async listOffers(token) {
      const { items } = await json<{ items: RiderOfferView[] }>(
        '/api/v1/rider/offers',
        auth(token),
      );
      return items;
    },
    async acceptOffer(token, offerId) {
      return json<AcceptView>(`/api/v1/rider/offers/${offerId}/accept`, post(token));
    },
    async getDelivery(token, orderUlid) {
      return json<DeliveryView>(`/api/v1/rider/deliveries/${orderUlid}`, auth(token));
    },
    async pickup(token, orderUlid) {
      return json<DeliveryView>(`/api/v1/rider/deliveries/${orderUlid}/pickup`, post(token));
    },
    async startDelivery(token, orderUlid) {
      return json<DeliveryView>(`/api/v1/rider/deliveries/${orderUlid}/start`, post(token));
    },
    async completeDelivery(token, orderUlid, pin) {
      return json<DeliveryView>(
        `/api/v1/rider/deliveries/${orderUlid}/complete`,
        post(token, { pin }),
      );
    },
    async getMe(token) {
      return json<RiderProfile>('/api/v1/rider/me', auth(token));
    },
    async getEarnings(token) {
      return json<RiderEarnings>('/api/v1/rider/earnings', auth(token));
    },
    async setPayoutDestination(token, phone) {
      return json<RiderProfile>('/api/v1/rider/payout-destination', post(token, { phone }));
    },
    async apply(token, vehicleType) {
      return json<RiderProfile>('/api/v1/rider/apply', post(token, { vehicleType }));
    },
    async ping(token, lat, lng) {
      await json('/api/v1/rider/ping', post(token, { lat, lng }));
    },
    async declineOffer(token, offerId) {
      await json(`/api/v1/rider/offers/${offerId}/decline`, post(token));
    },
  };
}
