import { describe, expect, it } from 'vitest';
import type { ZoneRecord } from '../zones/repo';
import type { ZoneService } from '../zones/zone-service';
import { createAddressService, type Actor } from './address-service';
import type {
  AddressRecord,
  AddressRepo,
  AddressWithZone,
  CreateAddressInput,
  UpdateAddressPatch,
} from './repo';

const CBD: ZoneRecord = {
  id: 1,
  ulid: 'Z1',
  townId: 1,
  name: 'CBD',
  centerLat: -1.0634,
  centerLng: 34.4731,
  radiusM: 3000,
  isActive: true,
};

class FakeAddressRepo implements AddressRepo {
  users = new Map<string, number>([
    ['cust', 7],
    ['other', 8],
  ]);
  zonesById = new Map<number, { ulid: string; name: string }>([[1, { ulid: 'Z1', name: 'CBD' }]]);
  rows: AddressRecord[] = [];
  private seq = 0;

  private withZone(a: AddressRecord): AddressWithZone {
    const z = a.zoneId !== null ? this.zonesById.get(a.zoneId) : undefined;
    return { ...a, zoneUlid: z?.ulid ?? null, zoneName: z?.name ?? null };
  }

  findUserIdByUlid(ulid: string): Promise<number | null> {
    return Promise.resolve(this.users.get(ulid) ?? null);
  }
  createAddress(input: CreateAddressInput): Promise<AddressWithZone> {
    const rec: AddressRecord = { id: ++this.seq, ...input };
    this.rows.push(rec);
    return Promise.resolve(this.withZone(rec));
  }
  listAddresses(userId: number): Promise<AddressWithZone[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.userId === userId).map((r) => this.withZone(r)),
    );
  }
  findAddressByUlid(ulid: string): Promise<AddressRecord | null> {
    return Promise.resolve(this.rows.find((r) => r.ulid === ulid) ?? null);
  }
  findAddressWithZoneByUlid(ulid: string): Promise<AddressWithZone | null> {
    const r = this.rows.find((row) => row.ulid === ulid);
    return Promise.resolve(r ? this.withZone(r) : null);
  }
  updateAddress(id: number, patch: UpdateAddressPatch): Promise<void> {
    const r = this.rows.find((row) => row.id === id);
    if (r) {
      Object.assign(r, patch);
    }
    return Promise.resolve();
  }
  deleteAddress(id: number): Promise<void> {
    this.rows = this.rows.filter((r) => r.id !== id);
    return Promise.resolve();
  }
}

/** A point is serviceable (resolves to the CBD zone) when its latitude is negative, else out. */
function fakeZoneService(): ZoneService {
  return {
    resolveZone: (lat: number) => Promise.resolve(lat < 0 ? CBD : null),
    createZone: () => Promise.reject(new Error('unused')),
    updateZone: () => Promise.reject(new Error('unused')),
    listZones: () => Promise.reject(new Error('unused')),
  } as unknown as ZoneService;
}

const CUST: Actor = { ulid: 'cust', roles: ['customer'] };
const OTHER: Actor = { ulid: 'other', roles: ['customer'] };

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

function makeSvc(repo = new FakeAddressRepo()) {
  return { repo, svc: createAddressService({ repo, zoneService: fakeZoneService() }) };
}

describe('address service', () => {
  it('resolves the zone on create for an in-zone point', async () => {
    const { svc } = makeSvc();
    const addr = await svc.createAddress(CUST, { line1: 'Main St', lat: -1.06, lng: 34.47 });
    expect(addr.serviceable).toBe(true);
    expect(addr.zone).toEqual({ ulid: 'Z1', name: 'CBD' });
  });

  it('marks an out-of-zone point unserviceable with a null zone', async () => {
    const { svc } = makeSvc();
    const addr = await svc.createAddress(CUST, { label: 'Home', line1: 'Far', lat: 10, lng: 10 });
    expect(addr.serviceable).toBe(false);
    expect(addr.zone).toBeNull();
  });

  it('lists only the caller’s own addresses', async () => {
    const { svc } = makeSvc();
    await svc.createAddress(CUST, { line1: 'A', lat: -1, lng: 34 });
    await svc.createAddress(OTHER, { line1: 'B', lat: -1, lng: 34 });
    const list = await svc.listAddresses(CUST);
    expect(list).toHaveLength(1);
    expect(list[0]?.line1).toBe('A');
  });

  it('re-resolves the zone when the point moves out of zone', async () => {
    const { svc } = makeSvc();
    const created = await svc.createAddress(CUST, { line1: 'A', lat: -1, lng: 34 });
    expect(created.serviceable).toBe(true);
    const moved = await svc.updateAddress(CUST, created.ulid, { lat: 10, lng: 10 });
    expect(moved.serviceable).toBe(false);
    expect(moved.zone).toBeNull();
  });

  it('does not re-resolve when only the label changes', async () => {
    const { svc } = makeSvc();
    const created = await svc.createAddress(CUST, { line1: 'A', lat: -1, lng: 34 });
    const renamed = await svc.updateAddress(CUST, created.ulid, { label: 'Office' });
    expect(renamed.label).toBe('Office');
    expect(renamed.serviceable).toBe(true); // zone unchanged
  });

  it('404s when updating or deleting someone else’s address', async () => {
    const { svc } = makeSvc();
    const created = await svc.createAddress(CUST, { line1: 'A', lat: -1, lng: 34 });
    expect(await thrownStatus(svc.updateAddress(OTHER, created.ulid, { label: 'x' }))).toBe(404);
    expect(await thrownStatus(svc.deleteAddress(OTHER, created.ulid))).toBe(404);
  });

  it('deletes an owned address', async () => {
    const { svc } = makeSvc();
    const created = await svc.createAddress(CUST, { line1: 'A', lat: -1, lng: 34 });
    await svc.deleteAddress(CUST, created.ulid);
    expect(await svc.listAddresses(CUST)).toEqual([]);
  });

  it('401s when the principal has no matching user', async () => {
    const { svc } = makeSvc();
    const ghost: Actor = { ulid: 'ghost', roles: ['customer'] };
    expect(await thrownStatus(svc.createAddress(ghost, { line1: 'A', lat: -1, lng: 34 }))).toBe(
      401,
    );
  });
});
