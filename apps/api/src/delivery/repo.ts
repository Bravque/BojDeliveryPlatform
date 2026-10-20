import type { Knex } from 'knex';
import type { OrderStatus } from '../orders/state-machine';

/**
 * Persistence for rider assignment: offers + deliveries + the candidate query. Executor-bound like
 * the other repos, so the same code serves plain reads and the atomic accept transaction. Order
 * reads/writes stay with the orders repo; this repo owns `assignment_offer` + `delivery` and the
 * candidate selection over `rider_profile`.
 */

export type OfferStatus = 'offered' | 'accepted' | 'declined' | 'expired' | 'superseded';
export type DeliveryStatus = 'unassigned' | 'assigned' | 'picked_up' | 'delivered' | 'failed';

export interface OfferRecord {
  id: number;
  orderId: number;
  orderUlid: string;
  riderId: number;
  status: OfferStatus;
  expiresAt: Date;
}

export interface DeliveryRecord {
  id: number;
  orderId: number;
  riderId: number | null;
  status: DeliveryStatus;
  riderFeeCents: number;
}

export interface AssignmentContext {
  orderId: number;
  orderUlid: string;
  status: OrderStatus;
  deliveryFeeCents: number;
  merchantLat: number | null;
  merchantLng: number | null;
}

export interface CandidateRow {
  userId: number;
  lat: number;
  lng: number;
}

export interface RiderOfferView {
  offerId: number;
  orderUlid: string;
  expiresAt: string;
}

export interface DeliveryRepo {
  findUserIdByUlid(ulid: string): Promise<number | null>;

  // --- assignment context + candidates ---
  getAssignmentContext(orderUlid: string): Promise<AssignmentContext | null>;
  listCandidateRiders(freshnessCutoff: Date): Promise<CandidateRow[]>;
  listOfferedRiderIds(orderId: number): Promise<number[]>;

  // --- offers ---
  insertOffer(input: { orderId: number; riderId: number; expiresAt: Date }): Promise<number>;
  findLiveOffer(orderId: number, now: Date): Promise<OfferRecord | null>;
  findOfferById(offerId: number): Promise<OfferRecord | null>;
  /** Lock an offer row inside a transaction (FOR UPDATE). */
  lockOfferById(offerId: number): Promise<OfferRecord | null>;
  markOfferStatus(offerId: number, status: OfferStatus, respondedAt: Date | null): Promise<void>;
  supersedeOtherOffers(orderId: number, exceptOfferId: number): Promise<void>;
  listLiveOffersForRider(riderId: number, now: Date): Promise<RiderOfferView[]>;
  /** Mark every open-but-expired offer `expired`; returns how many. */
  expireStaleOffers(now: Date): Promise<number>;
  /** Order ulids in `ready_for_pickup` with no live offer and no delivery — awaiting an offer. */
  listReadyOrdersForAssignment(now: Date): Promise<string[]>;

  // --- delivery ---
  insertDelivery(input: {
    orderId: number;
    riderId: number;
    status: DeliveryStatus;
    riderFeeCents: number;
  }): Promise<number>;
  findDeliveryByOrderId(orderId: number): Promise<DeliveryRecord | null>;
}

interface OfferRowDb {
  id: number | string;
  order_id: number | string;
  order_ulid: string;
  rider_id: number | string;
  status: OfferStatus;
  expires_at: string | Date;
}

function mapOffer(row: OfferRowDb): OfferRecord {
  return {
    id: Number(row.id),
    orderId: Number(row.order_id),
    orderUlid: row.order_ulid,
    riderId: Number(row.rider_id),
    status: row.status,
    expiresAt: new Date(row.expires_at),
  };
}

const OFFER_COLUMNS = [
  'assignment_offer.id as id',
  'assignment_offer.order_id as order_id',
  'order.ulid as order_ulid',
  'assignment_offer.rider_id as rider_id',
  'assignment_offer.status as status',
  'assignment_offer.expires_at as expires_at',
];

export function createKnexDeliveryRepo(exec: Knex): DeliveryRepo {
  return {
    async findUserIdByUlid(ulid) {
      const row = (await exec('user').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async getAssignmentContext(orderUlid) {
      const row = (await exec('order')
        .join('merchant', 'merchant.id', 'order.merchant_id')
        .where('order.ulid', orderUlid)
        .first(
          'order.id as order_id',
          'order.ulid as order_ulid',
          'order.status as status',
          'order.delivery_fee_cents as delivery_fee_cents',
          'merchant.lat as merchant_lat',
          'merchant.lng as merchant_lng',
        )) as
        | {
            order_id: number | string;
            order_ulid: string;
            status: OrderStatus;
            delivery_fee_cents: number | string;
            merchant_lat: number | string | null;
            merchant_lng: number | string | null;
          }
        | undefined;
      if (!row) {
        return null;
      }
      return {
        orderId: Number(row.order_id),
        orderUlid: row.order_ulid,
        status: row.status,
        deliveryFeeCents: Number(row.delivery_fee_cents),
        merchantLat: row.merchant_lat === null ? null : Number(row.merchant_lat),
        merchantLng: row.merchant_lng === null ? null : Number(row.merchant_lng),
      };
    },

    async listCandidateRiders(freshnessCutoff) {
      const rows = (await exec('rider_profile as rp')
        .where('rp.status', 'approved')
        .where('rp.is_online', true)
        .where('rp.last_ping_at', '>=', freshnessCutoff)
        .whereNotNull('rp.last_lat')
        .whereNotNull('rp.last_lng')
        .whereNotExists(function () {
          this.select('*')
            .from('delivery as d')
            .whereRaw('d.rider_id = rp.user_id')
            .whereIn('d.status', ['assigned', 'picked_up']);
        })
        .select('rp.user_id as userId', 'rp.last_lat as lat', 'rp.last_lng as lng')) as Array<{
        userId: number | string;
        lat: number | string;
        lng: number | string;
      }>;
      return rows.map((r) => ({
        userId: Number(r.userId),
        lat: Number(r.lat),
        lng: Number(r.lng),
      }));
    },

    async listOfferedRiderIds(orderId) {
      const rows = (await exec('assignment_offer')
        .where({ order_id: orderId })
        .select('rider_id')) as Array<{ rider_id: number | string }>;
      return rows.map((r) => Number(r.rider_id));
    },

    async insertOffer(input) {
      const [id] = await exec('assignment_offer').insert({
        order_id: input.orderId,
        rider_id: input.riderId,
        expires_at: input.expiresAt,
      });
      return Number(id);
    },

    async findLiveOffer(orderId, now) {
      const row = (await exec('assignment_offer')
        .join('order', 'order.id', 'assignment_offer.order_id')
        .where('assignment_offer.order_id', orderId)
        .where('assignment_offer.status', 'offered')
        .where('assignment_offer.expires_at', '>', now)
        .first(OFFER_COLUMNS)) as OfferRowDb | undefined;
      return row ? mapOffer(row) : null;
    },

    async findOfferById(offerId) {
      const row = (await exec('assignment_offer')
        .join('order', 'order.id', 'assignment_offer.order_id')
        .where('assignment_offer.id', offerId)
        .first(OFFER_COLUMNS)) as OfferRowDb | undefined;
      return row ? mapOffer(row) : null;
    },

    async lockOfferById(offerId) {
      const row = (await exec('assignment_offer')
        .join('order', 'order.id', 'assignment_offer.order_id')
        .where('assignment_offer.id', offerId)
        .forUpdate('assignment_offer')
        .first(OFFER_COLUMNS)) as OfferRowDb | undefined;
      return row ? mapOffer(row) : null;
    },

    async markOfferStatus(offerId, status, respondedAt) {
      await exec('assignment_offer')
        .where({ id: offerId })
        .update({ status, responded_at: respondedAt });
    },

    async supersedeOtherOffers(orderId, exceptOfferId) {
      await exec('assignment_offer')
        .where({ order_id: orderId, status: 'offered' })
        .whereNot('id', exceptOfferId)
        .update({ status: 'superseded' });
    },

    async listLiveOffersForRider(riderId, now) {
      const rows = (await exec('assignment_offer')
        .join('order', 'order.id', 'assignment_offer.order_id')
        .where('assignment_offer.rider_id', riderId)
        .where('assignment_offer.status', 'offered')
        .where('assignment_offer.expires_at', '>', now)
        .orderBy('assignment_offer.id', 'asc')
        .select(
          'assignment_offer.id as offer_id',
          'order.ulid as order_ulid',
          'assignment_offer.expires_at as expires_at',
        )) as Array<{ offer_id: number | string; order_ulid: string; expires_at: string | Date }>;
      return rows.map((r) => ({
        offerId: Number(r.offer_id),
        orderUlid: r.order_ulid,
        expiresAt: new Date(r.expires_at).toISOString(),
      }));
    },

    async expireStaleOffers(now) {
      const affected = await exec('assignment_offer')
        .where('status', 'offered')
        .where('expires_at', '<=', now)
        .update({ status: 'expired', responded_at: now });
      return Number(affected);
    },

    async listReadyOrdersForAssignment(now) {
      const rows = (await exec('order')
        .where('order.status', 'ready_for_pickup')
        .whereNotExists(function () {
          this.select('*')
            .from('assignment_offer as ao')
            .whereRaw('ao.order_id = `order`.id')
            .where('ao.status', 'offered')
            .where('ao.expires_at', '>', now);
        })
        .whereNotExists(function () {
          this.select('*').from('delivery as d').whereRaw('d.order_id = `order`.id');
        })
        .orderBy('order.id', 'asc')
        .select('order.ulid as ulid')) as Array<{ ulid: string }>;
      return rows.map((r) => r.ulid);
    },

    async insertDelivery(input) {
      const [id] = await exec('delivery').insert({
        order_id: input.orderId,
        rider_id: input.riderId,
        status: input.status,
        rider_fee_cents: input.riderFeeCents,
      });
      return Number(id);
    },

    async findDeliveryByOrderId(orderId) {
      const row = (await exec('delivery').where({ order_id: orderId }).first()) as
        | {
            id: number | string;
            order_id: number | string;
            rider_id: number | string | null;
            status: DeliveryStatus;
            rider_fee_cents: number | string;
          }
        | undefined;
      if (!row) {
        return null;
      }
      return {
        id: Number(row.id),
        orderId: Number(row.order_id),
        riderId: row.rider_id === null ? null : Number(row.rider_id),
        status: row.status,
        riderFeeCents: Number(row.rider_fee_cents),
      };
    },
  };
}
