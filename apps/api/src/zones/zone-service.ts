import type { AuditService } from '../auth/audit-service';
import { newUlid } from '../auth/crypto';
import { haversineMeters } from '../geo/distance';
import { badRequest, notFound } from '../http/errors';
import type { ZoneRecord, ZoneRepo } from './repo';

/** The acting principal (from req.principal). Resolved to a DB user id for the audit trail. */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface CreateZoneInput {
  townName: string;
  name: string;
  centerLat: number;
  centerLng: number;
  radiusM: number;
  isActive?: boolean;
}

export interface UpdateZoneInput {
  name?: string;
  centerLat?: number;
  centerLng?: number;
  radiusM?: number;
  isActive?: boolean;
}

export interface ZoneSummary {
  ulid: string;
  name: string;
  centerLat: number | null;
  centerLng: number | null;
  radiusM: number | null;
  isActive: boolean;
}

export interface ZoneWithTownSummary extends ZoneSummary {
  townUlid: string;
  townName: string;
}

export interface ZoneServiceDeps {
  repo: ZoneRepo;
  auditService: AuditService;
}

function toSummary(z: ZoneRecord): ZoneSummary {
  return {
    ulid: z.ulid,
    name: z.name,
    centerLat: z.centerLat,
    centerLng: z.centerLng,
    radiusM: z.radiusM,
    isActive: z.isActive,
  };
}

export function createZoneService(deps: ZoneServiceDeps) {
  const { repo, auditService } = deps;

  function actorRole(actor: Actor): string {
    return actor.roles.includes('admin') ? 'admin' : (actor.roles[0] ?? 'unknown');
  }

  async function audit(
    actor: Actor,
    action: string,
    entityId: number,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await auditService.record({
      actorUserId: await repo.findUserIdByUlid(actor.ulid),
      actorRole: actorRole(actor),
      action,
      entityType: 'zone',
      entityId,
      before,
      after,
    });
  }

  async function createZone(actor: Actor, input: CreateZoneInput): Promise<ZoneSummary> {
    const townId = await repo.findTownIdByName(input.townName);
    if (townId === null) {
      throw badRequest('Unknown town', [{ field: 'townName', issue: 'not found' }]);
    }
    const zone = await repo.createZone({
      ulid: newUlid(),
      townId,
      name: input.name,
      centerLat: input.centerLat,
      centerLng: input.centerLng,
      radiusM: input.radiusM,
      isActive: input.isActive ?? false,
    });
    await audit(actor, 'zone.create', zone.id, null, {
      name: zone.name,
      isActive: zone.isActive,
    });
    return toSummary(zone);
  }

  async function updateZone(
    actor: Actor,
    zoneUlid: string,
    patch: UpdateZoneInput,
  ): Promise<ZoneSummary> {
    const zone = await repo.findZoneByUlid(zoneUlid);
    if (!zone) {
      throw notFound('Zone not found');
    }

    const next: ZoneRecord = {
      ...zone,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.centerLat !== undefined && { centerLat: patch.centerLat }),
      ...(patch.centerLng !== undefined && { centerLng: patch.centerLng }),
      ...(patch.radiusM !== undefined && { radiusM: patch.radiusM }),
      ...(patch.isActive !== undefined && { isActive: patch.isActive }),
    };

    // A zone can only be active with a complete circle, so it can always be resolved.
    if (next.isActive && (next.centerLat === null || next.centerLng === null || !next.radiusM)) {
      throw badRequest('An active zone needs a centre point and a positive radius', [
        { field: 'isActive', issue: 'requires centerLat, centerLng and radiusM' },
      ]);
    }

    await repo.updateZone(zone.id, patch);
    await audit(
      actor,
      'zone.update',
      zone.id,
      { name: zone.name, isActive: zone.isActive },
      { name: next.name, isActive: next.isActive },
    );
    return toSummary(next);
  }

  async function listZones(townName?: string): Promise<ZoneWithTownSummary[]> {
    let townId: number | undefined;
    if (townName !== undefined) {
      const resolved = await repo.findTownIdByName(townName);
      if (resolved === null) {
        return [];
      }
      townId = resolved;
    }
    const zones = await repo.listZones(townId);
    return zones.map((z) => ({ ...toSummary(z), townUlid: z.townUlid, townName: z.townName }));
  }

  /**
   * Resolve a point to the serviceable zone it falls in, or `null` (out of zone). When several
   * zones overlap the point, the nearest centre wins — a deterministic, total function.
   */
  async function resolveZone(lat: number, lng: number): Promise<ZoneRecord | null> {
    const candidates = await repo.listServiceableZones();
    let best: { zone: ZoneRecord; distance: number } | null = null;
    for (const zone of candidates) {
      if (zone.centerLat === null || zone.centerLng === null || zone.radiusM === null) {
        continue;
      }
      const distance = haversineMeters({ lat, lng }, { lat: zone.centerLat, lng: zone.centerLng });
      if (distance <= zone.radiusM && (best === null || distance < best.distance)) {
        best = { zone, distance };
      }
    }
    return best?.zone ?? null;
  }

  return { createZone, updateZone, listZones, resolveZone };
}

export type ZoneService = ReturnType<typeof createZoneService>;
