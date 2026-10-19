import type { Knex } from 'knex';

/**
 * Persistence for customer delivery addresses, behind an interface for in-memory unit testing.
 * `zone_id` is the zone the address resolved to at save time (NULL = outside every serviceable
 * zone); the owning `user_id` is always set from the authenticated principal, never the client.
 */

export interface AddressRecord {
  id: number;
  ulid: string;
  userId: number;
  label: string | null;
  line1: string;
  lat: number;
  lng: number;
  zoneId: number | null;
}

/** An address enriched with its resolved zone's public fields, for customer-facing reads. */
export interface AddressWithZone extends AddressRecord {
  zoneUlid: string | null;
  zoneName: string | null;
}

export interface CreateAddressInput {
  ulid: string;
  userId: number;
  label: string | null;
  line1: string;
  lat: number;
  lng: number;
  zoneId: number | null;
}

export interface UpdateAddressPatch {
  label?: string | null;
  line1?: string;
  lat?: number;
  lng?: number;
  zoneId?: number | null;
}

export interface AddressRepo {
  findUserIdByUlid(ulid: string): Promise<number | null>;
  createAddress(input: CreateAddressInput): Promise<AddressWithZone>;
  listAddresses(userId: number): Promise<AddressWithZone[]>;
  findAddressByUlid(ulid: string): Promise<AddressRecord | null>;
  findAddressWithZoneByUlid(ulid: string): Promise<AddressWithZone | null>;
  updateAddress(id: number, patch: UpdateAddressPatch): Promise<void>;
  deleteAddress(id: number): Promise<void>;
}

interface AddressRowDb {
  id: number | string;
  ulid: string;
  user_id: number | string;
  label: string | null;
  line1: string;
  lat: string | number;
  lng: string | number;
  zone_id: number | string | null;
}

function mapAddress(row: AddressRowDb): AddressRecord {
  return {
    id: Number(row.id),
    ulid: row.ulid,
    userId: Number(row.user_id),
    label: row.label,
    line1: row.line1,
    lat: Number(row.lat),
    lng: Number(row.lng),
    zoneId: row.zone_id === null ? null : Number(row.zone_id),
  };
}

function mapWithZone(
  row: AddressRowDb & { zone_ulid: string | null; zone_name: string | null },
): AddressWithZone {
  return { ...mapAddress(row), zoneUlid: row.zone_ulid, zoneName: row.zone_name };
}

function withZoneQuery(db: Knex) {
  return db('address')
    .leftJoin('zone', 'zone.id', 'address.zone_id')
    .select(
      'address.id as id',
      'address.ulid as ulid',
      'address.user_id as user_id',
      'address.label as label',
      'address.line1 as line1',
      'address.lat as lat',
      'address.lng as lng',
      'address.zone_id as zone_id',
      'zone.ulid as zone_ulid',
      'zone.name as zone_name',
    );
}

export function createKnexAddressRepo(db: Knex): AddressRepo {
  return {
    async findUserIdByUlid(ulid) {
      const row = (await db('user').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async createAddress(input) {
      const inserted = await db('address').insert({
        ulid: input.ulid,
        user_id: input.userId,
        label: input.label,
        line1: input.line1,
        lat: input.lat,
        lng: input.lng,
        zone_id: input.zoneId,
      });
      const id = inserted[0];
      if (id === undefined) {
        throw new Error('Failed to create address');
      }
      const row = (await withZoneQuery(db).where('address.id', id).first()) as AddressRowDb & {
        zone_ulid: string | null;
        zone_name: string | null;
      };
      return mapWithZone(row);
    },

    async listAddresses(userId) {
      const rows = (await withZoneQuery(db)
        .where('address.user_id', userId)
        .orderBy('address.id', 'asc')) as Array<
        AddressRowDb & { zone_ulid: string | null; zone_name: string | null }
      >;
      return rows.map(mapWithZone);
    },

    async findAddressByUlid(ulid) {
      const row = (await db('address').where({ ulid }).first()) as AddressRowDb | undefined;
      return row ? mapAddress(row) : null;
    },

    async findAddressWithZoneByUlid(ulid) {
      const row = (await withZoneQuery(db).where('address.ulid', ulid).first()) as
        (AddressRowDb & { zone_ulid: string | null; zone_name: string | null }) | undefined;
      return row ? mapWithZone(row) : null;
    },

    async updateAddress(id, patch) {
      const row: Record<string, unknown> = {};
      if (patch.label !== undefined) row.label = patch.label;
      if (patch.line1 !== undefined) row.line1 = patch.line1;
      if (patch.lat !== undefined) row.lat = patch.lat;
      if (patch.lng !== undefined) row.lng = patch.lng;
      if (patch.zoneId !== undefined) row.zone_id = patch.zoneId;
      if (Object.keys(row).length > 0) {
        await db('address').where({ id }).update(row);
      }
    },

    async deleteAddress(id) {
      await db('address').where({ id }).del();
    },
  };
}
