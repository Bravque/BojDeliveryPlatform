import { describe, expect, it } from 'vitest';
import type { AuditService } from '../auth/audit-service';
import { createZoneService, type Actor } from './zone-service';
import type { CreateZoneInput, UpdateZonePatch, ZoneRecord, ZoneRepo, ZoneWithTown } from './repo';

class FakeZoneRepo implements ZoneRepo {
  towns = new Map<string, number>([['Migori', 1]]);
  zones: ZoneRecord[] = [];
  private seq = 0;

  findTownIdByName(name: string): Promise<number | null> {
    return Promise.resolve(this.towns.get(name) ?? null);
  }
  findUserIdByUlid(): Promise<number | null> {
    return Promise.resolve(42);
  }
  createZone(input: CreateZoneInput): Promise<ZoneRecord> {
    const rec: ZoneRecord = {
      id: ++this.seq,
      ulid: input.ulid,
      townId: input.townId,
      name: input.name,
      centerLat: input.centerLat,
      centerLng: input.centerLng,
      radiusM: input.radiusM,
      isActive: input.isActive,
    };
    this.zones.push(rec);
    return Promise.resolve(rec);
  }
  findZoneByUlid(ulid: string): Promise<ZoneRecord | null> {
    return Promise.resolve(this.zones.find((z) => z.ulid === ulid) ?? null);
  }
  updateZone(id: number, patch: UpdateZonePatch): Promise<void> {
    const z = this.zones.find((zone) => zone.id === id);
    if (z) {
      Object.assign(z, patch);
    }
    return Promise.resolve();
  }
  listZones(townId?: number): Promise<ZoneWithTown[]> {
    const rows = this.zones.filter((z) => townId === undefined || z.townId === townId);
    return Promise.resolve(rows.map((z) => ({ ...z, townName: 'Migori', townUlid: 'T1' })));
  }
  listServiceableZones(): Promise<ZoneRecord[]> {
    return Promise.resolve(
      this.zones.filter(
        (z) => z.isActive && z.centerLat !== null && z.centerLng !== null && z.radiusM !== null,
      ),
    );
  }
}

function fakeAudit(): { service: AuditService; entries: Array<{ action: string }> } {
  const entries: Array<{ action: string }> = [];
  const service = {
    record: (e: { action: string }) => {
      entries.push(e);
      return Promise.resolve();
    },
    listRecent: () => Promise.resolve([]),
  } as unknown as AuditService;
  return { service, entries };
}

const ADMIN: Actor = { ulid: 'admin-ulid', roles: ['admin'] };

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

const validCreate = {
  townName: 'Migori',
  name: 'Migori CBD',
  centerLat: -1.0634,
  centerLng: 34.4731,
  radiusM: 3000,
};

describe('zone service — admin configuration', () => {
  it('creates a zone and records an audit entry', async () => {
    const repo = new FakeZoneRepo();
    const audit = fakeAudit();
    const svc = createZoneService({ repo, auditService: audit.service });

    const zone = await svc.createZone(ADMIN, validCreate);
    expect(zone.name).toBe('Migori CBD');
    expect(zone.isActive).toBe(false); // inactive by default
    expect(audit.entries.map((e) => e.action)).toContain('zone.create');
  });

  it('rejects an unknown town with 400', async () => {
    const svc = createZoneService({ repo: new FakeZoneRepo(), auditService: fakeAudit().service });
    expect(await thrownStatus(svc.createZone(ADMIN, { ...validCreate, townName: 'Nairobi' }))).toBe(
      400,
    );
  });

  it('refuses to activate a zone without a complete circle (400)', async () => {
    const repo = new FakeZoneRepo();
    const svc = createZoneService({ repo, auditService: fakeAudit().service });
    const zone = await svc.createZone(ADMIN, validCreate);
    // Null out the radius, then try to activate.
    await repo.updateZone(1, { radiusM: undefined });
    repo.zones[0]!.radiusM = null;
    expect(await thrownStatus(svc.updateZone(ADMIN, zone.ulid, { isActive: true }))).toBe(400);
  });

  it('activates a complete zone and lists it for its town', async () => {
    const repo = new FakeZoneRepo();
    const svc = createZoneService({ repo, auditService: fakeAudit().service });
    const zone = await svc.createZone(ADMIN, validCreate);
    const updated = await svc.updateZone(ADMIN, zone.ulid, { isActive: true, name: 'CBD' });
    expect(updated.isActive).toBe(true);
    expect(updated.name).toBe('CBD');

    const list = await svc.listZones('Migori');
    expect(list).toHaveLength(1);
    expect(list[0]?.townUlid).toBe('T1');
    expect(await svc.listZones('Nairobi')).toEqual([]);
  });

  it('404s when updating an unknown zone', async () => {
    const svc = createZoneService({ repo: new FakeZoneRepo(), auditService: fakeAudit().service });
    expect(await thrownStatus(svc.updateZone(ADMIN, 'nope', { name: 'x' }))).toBe(404);
  });
});

describe('zone service — resolveZone', () => {
  async function seeded(): Promise<ReturnType<typeof createZoneService>> {
    const repo = new FakeZoneRepo();
    const svc = createZoneService({ repo, auditService: fakeAudit().service });
    // Active serviceable zone around the CBD.
    const cbd = await svc.createZone(ADMIN, validCreate);
    await svc.updateZone(ADMIN, cbd.ulid, { isActive: true });
    // An inactive zone covering the same point must be ignored.
    const inactive = await svc.createZone(ADMIN, { ...validCreate, name: 'Draft', radiusM: 50000 });
    void inactive;
    return svc;
  }

  it('resolves a point inside the radius to the zone', async () => {
    const svc = await seeded();
    const zone = await svc.resolveZone(-1.0634, 34.4731);
    expect(zone?.name).toBe('Migori CBD');
  });

  it('returns null for a point outside every serviceable zone', async () => {
    const svc = await seeded();
    expect(await svc.resolveZone(0, 0)).toBeNull();
  });

  it('ignores inactive zones even when they cover the point', async () => {
    const repo = new FakeZoneRepo();
    const svc = createZoneService({ repo, auditService: fakeAudit().service });
    await svc.createZone(ADMIN, { ...validCreate, radiusM: 50000 }); // inactive by default
    expect(await svc.resolveZone(-1.0634, 34.4731)).toBeNull();
  });

  it('picks the nearest centre when zones overlap', async () => {
    const repo = new FakeZoneRepo();
    const svc = createZoneService({ repo, auditService: fakeAudit().service });
    const near = await svc.createZone(ADMIN, {
      townName: 'Migori',
      name: 'Near',
      centerLat: 0,
      centerLng: 0,
      radiusM: 5000,
    });
    const far = await svc.createZone(ADMIN, {
      townName: 'Migori',
      name: 'Far',
      centerLat: 0,
      centerLng: 0.01, // ~1.1 km away
      radiusM: 5000,
    });
    await svc.updateZone(ADMIN, near.ulid, { isActive: true });
    await svc.updateZone(ADMIN, far.ulid, { isActive: true });
    const zone = await svc.resolveZone(0, 0);
    expect(zone?.name).toBe('Near');
  });
});
