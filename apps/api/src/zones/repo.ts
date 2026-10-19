import type { Knex } from 'knex';

/**
 * Persistence for delivery zones (serviceable areas), behind an interface so the service can be
 * unit-tested with an in-memory fake. A zone is a **circle**: a centre point + radius in metres
 * (see migration 0008 for why, vs. a GEOMETRY polygon). The circle columns are nullable in the
 * schema; the service guarantees they are present before a zone is activated or used to resolve
 * an address.
 */

export interface ZoneRecord {
  id: number;
  ulid: string;
  townId: number;
  name: string;
  centerLat: number | null;
  centerLng: number | null;
  radiusM: number | null;
  isActive: boolean;
}

/** A zone enriched with its town's public fields, for admin listings. */
export interface ZoneWithTown extends ZoneRecord {
  townName: string;
  townUlid: string;
}

export interface CreateZoneInput {
  ulid: string;
  townId: number;
  name: string;
  centerLat: number;
  centerLng: number;
  radiusM: number;
  isActive: boolean;
}

export interface UpdateZonePatch {
  name?: string;
  centerLat?: number;
  centerLng?: number;
  radiusM?: number;
  isActive?: boolean;
}

export interface ZoneRepo {
  findTownIdByName(name: string): Promise<number | null>;
  findUserIdByUlid(ulid: string): Promise<number | null>;
  createZone(input: CreateZoneInput): Promise<ZoneRecord>;
  findZoneByUlid(ulid: string): Promise<ZoneRecord | null>;
  updateZone(id: number, patch: UpdateZonePatch): Promise<void>;
  listZones(townId?: number): Promise<ZoneWithTown[]>;
  /** Active zones with a complete circle definition — the resolution candidates. */
  listServiceableZones(): Promise<ZoneRecord[]>;
}

interface ZoneRowDb {
  id: number | string;
  ulid: string;
  town_id: number | string;
  name: string;
  center_lat: string | number | null;
  center_lng: string | number | null;
  radius_m: number | string | null;
  is_active: number | boolean;
}

function toNumberOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function mapZone(row: ZoneRowDb): ZoneRecord {
  return {
    id: Number(row.id),
    ulid: row.ulid,
    townId: Number(row.town_id),
    name: row.name,
    centerLat: toNumberOrNull(row.center_lat),
    centerLng: toNumberOrNull(row.center_lng),
    radiusM: toNumberOrNull(row.radius_m),
    isActive: Boolean(row.is_active),
  };
}

export function createKnexZoneRepo(db: Knex): ZoneRepo {
  return {
    async findTownIdByName(name) {
      const row = (await db('town').where({ name }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async findUserIdByUlid(ulid) {
      const row = (await db('user').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async createZone(input) {
      const inserted = await db('zone').insert({
        ulid: input.ulid,
        town_id: input.townId,
        name: input.name,
        center_lat: input.centerLat,
        center_lng: input.centerLng,
        radius_m: input.radiusM,
        is_active: input.isActive,
      });
      const id = inserted[0];
      if (id === undefined) {
        throw new Error('Failed to create zone');
      }
      const row = (await db('zone').where({ id }).first()) as ZoneRowDb;
      return mapZone(row);
    },

    async findZoneByUlid(ulid) {
      const row = (await db('zone').where({ ulid }).first()) as ZoneRowDb | undefined;
      return row ? mapZone(row) : null;
    },

    async updateZone(id, patch) {
      const row: Record<string, unknown> = {};
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.centerLat !== undefined) row.center_lat = patch.centerLat;
      if (patch.centerLng !== undefined) row.center_lng = patch.centerLng;
      if (patch.radiusM !== undefined) row.radius_m = patch.radiusM;
      if (patch.isActive !== undefined) row.is_active = patch.isActive;
      if (Object.keys(row).length > 0) {
        await db('zone').where({ id }).update(row);
      }
    },

    async listZones(townId) {
      const query = db('zone')
        .join('town', 'town.id', 'zone.town_id')
        .select(
          'zone.id as id',
          'zone.ulid as ulid',
          'zone.town_id as town_id',
          'zone.name as name',
          'zone.center_lat as center_lat',
          'zone.center_lng as center_lng',
          'zone.radius_m as radius_m',
          'zone.is_active as is_active',
          'town.name as town_name',
          'town.ulid as town_ulid',
        )
        .orderBy('zone.id', 'asc');
      if (townId !== undefined) {
        query.where('zone.town_id', townId);
      }
      const rows = (await query) as Array<ZoneRowDb & { town_name: string; town_ulid: string }>;
      return rows.map((row) => ({
        ...mapZone(row),
        townName: row.town_name,
        townUlid: row.town_ulid,
      }));
    },

    async listServiceableZones() {
      const rows = (await db('zone')
        .where({ is_active: true })
        .whereNotNull('center_lat')
        .whereNotNull('center_lng')
        .whereNotNull('radius_m')) as ZoneRowDb[];
      return rows.map(mapZone);
    },
  };
}
