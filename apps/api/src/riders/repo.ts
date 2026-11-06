import type { Knex } from 'knex';

/**
 * Persistence for the rider domain, behind an interface so the service can be unit-tested with an
 * in-memory fake. A `rider_profile` is keyed by `user_id`; the user's public `ulid` identifies a
 * rider at the API boundary, so reads join `user`. The global-role grant mirrors merchant
 * onboarding (approval makes the policy layer recognise the `rider` role).
 */

export type RiderStatus = 'pending' | 'approved' | 'suspended';
export type VehicleType = 'motorbike' | 'bicycle' | 'car' | 'foot';

export interface RiderRecord {
  userId: number;
  userUlid: string;
  status: RiderStatus;
  vehicleType: VehicleType;
  isOnline: boolean;
  lastLat: number | null;
  lastLng: number | null;
  lastPingAt: Date | null;
  ratingAvg: number | null;
  /** M-Pesa withdrawal destination; null = fall back to the sign-in number on payout. */
  payoutPhoneE164: string | null;
}

/** A rider's lifetime earnings from completed deliveries. */
export interface RiderEarnings {
  deliveries: number;
  totalEarnedCents: number;
}

/** A rider plus sign-in phone + application time, for the admin console list. */
export type RiderListRow = RiderRecord & { phoneE164: string | null; createdAt: Date };

export interface RiderRepo {
  findUserIdByUlid(ulid: string): Promise<number | null>;
  createRiderProfile(input: { userId: number; vehicleType: VehicleType }): Promise<RiderRecord>;
  findRiderByUserUlid(ulid: string): Promise<RiderRecord | null>;
  findRiderByUserId(userId: number): Promise<RiderRecord | null>;
  /** All rider profiles with sign-in phone, newest first (admin onboarding console). */
  listRiders(): Promise<RiderListRow[]>;
  setRiderStatus(userId: number, status: RiderStatus): Promise<void>;
  /** Set (or clear, with null) the rider's canonical-E.164 withdrawal destination. */
  setPayoutPhone(userId: number, phoneE164: string | null): Promise<void>;
  /** Sum of rider fees over this rider's delivered deliveries. */
  getEarnings(userId: number): Promise<RiderEarnings>;
  /** Idempotently grant a global role (user_role) so the policy layer recognizes the user. */
  grantGlobalRole(userId: number, roleCode: string): Promise<void>;

  // --- presence (increment 2) ---
  setOnline(userId: number, isOnline: boolean): Promise<void>;
  /** Record the latest location ping (updates last_lat/last_lng/last_ping_at = now). */
  recordPing(userId: number, lat: number, lng: number): Promise<void>;
}

interface RiderRowDb {
  user_id: number | string;
  user_ulid: string;
  status: RiderStatus;
  vehicle_type: VehicleType;
  is_online: number | boolean;
  last_lat: number | string | null;
  last_lng: number | string | null;
  last_ping_at: string | Date | null;
  rating_avg: number | string | null;
  payout_phone_e164: string | null;
}

function mapRider(row: RiderRowDb): RiderRecord {
  return {
    userId: Number(row.user_id),
    userUlid: row.user_ulid,
    status: row.status,
    vehicleType: row.vehicle_type,
    isOnline: Boolean(row.is_online),
    lastLat: row.last_lat === null ? null : Number(row.last_lat),
    lastLng: row.last_lng === null ? null : Number(row.last_lng),
    lastPingAt: row.last_ping_at === null ? null : new Date(row.last_ping_at),
    ratingAvg: row.rating_avg === null ? null : Number(row.rating_avg),
    payoutPhoneE164: row.payout_phone_e164 ?? null,
  };
}

const RIDER_COLUMNS = [
  'rider_profile.user_id',
  'user.ulid as user_ulid',
  'rider_profile.status',
  'rider_profile.vehicle_type',
  'rider_profile.is_online',
  'rider_profile.last_lat',
  'rider_profile.last_lng',
  'rider_profile.last_ping_at',
  'rider_profile.rating_avg',
  'rider_profile.payout_phone_e164',
];

export function createKnexRiderRepo(db: Knex): RiderRepo {
  return {
    async findUserIdByUlid(ulid) {
      const row = (await db('user').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async createRiderProfile(input) {
      await db('rider_profile').insert({ user_id: input.userId, vehicle_type: input.vehicleType });
      const row = (await db('rider_profile')
        .join('user', 'user.id', 'rider_profile.user_id')
        .where('rider_profile.user_id', input.userId)
        .first(RIDER_COLUMNS)) as RiderRowDb;
      return mapRider(row);
    },

    async findRiderByUserUlid(ulid) {
      const row = (await db('rider_profile')
        .join('user', 'user.id', 'rider_profile.user_id')
        .where('user.ulid', ulid)
        .first(RIDER_COLUMNS)) as RiderRowDb | undefined;
      return row ? mapRider(row) : null;
    },

    async findRiderByUserId(userId) {
      const row = (await db('rider_profile')
        .join('user', 'user.id', 'rider_profile.user_id')
        .where('rider_profile.user_id', userId)
        .first(RIDER_COLUMNS)) as RiderRowDb | undefined;
      return row ? mapRider(row) : null;
    },

    async listRiders() {
      const rows = (await db('rider_profile')
        .join('user', 'user.id', 'rider_profile.user_id')
        .orderBy('rider_profile.created_at', 'desc')
        .select([
          ...RIDER_COLUMNS,
          'user.phone_e164 as phone_e164',
          'rider_profile.created_at as created_at',
        ])) as Array<RiderRowDb & { phone_e164: string | null; created_at: string | Date }>;
      return rows.map((r) => ({
        ...mapRider(r),
        phoneE164: r.phone_e164 ?? null,
        createdAt: new Date(r.created_at),
      }));
    },

    async setRiderStatus(userId, status) {
      await db('rider_profile').where({ user_id: userId }).update({ status });
    },

    async setPayoutPhone(userId, phoneE164) {
      await db('rider_profile').where({ user_id: userId }).update({ payout_phone_e164: phoneE164 });
    },

    async getEarnings(userId) {
      const row = (await db('delivery')
        .where({ rider_id: userId, status: 'delivered' })
        .count({ deliveries: '*' })
        .sum({ total: 'rider_fee_cents' })
        .first()) as { deliveries: number | string; total: number | string | null } | undefined;
      return {
        deliveries: Number(row?.deliveries ?? 0),
        totalEarnedCents: Number(row?.total ?? 0),
      };
    },

    async setOnline(userId, isOnline) {
      await db('rider_profile').where({ user_id: userId }).update({ is_online: isOnline });
    },

    async recordPing(userId, lat, lng) {
      await db('rider_profile')
        .where({ user_id: userId })
        .update({ last_lat: lat, last_lng: lng, last_ping_at: db.raw('CURRENT_TIMESTAMP(3)') });
    },

    async grantGlobalRole(userId, roleCode) {
      const role = (await db('role').where({ code: roleCode }).first('id')) as
        { id: number | string } | undefined;
      if (!role) {
        throw new Error(`Role not found: ${roleCode}`);
      }
      await db('user_role')
        .insert({ user_id: userId, role_id: role.id })
        .onConflict(['user_id', 'role_id'])
        .ignore();
    },
  };
}
