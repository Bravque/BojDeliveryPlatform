import { describe, expect, it } from 'vitest';
import { createPresenceService, type Actor } from './presence-service';
import type { RiderRecord, RiderRepo, RiderStatus } from './repo';

class FakeRiderRepo implements RiderRepo {
  rider: RiderRecord;
  pings = 0;
  onlineWrites: boolean[] = [];

  constructor(over: { status?: RiderStatus; lastPingAt?: Date | null } = {}) {
    this.rider = {
      userId: 42,
      userUlid: 'RIDER-ULID',
      status: over.status ?? 'approved',
      vehicleType: 'motorbike',
      isOnline: false,
      lastLat: null,
      lastLng: null,
      lastPingAt: over.lastPingAt ?? null,
      ratingAvg: null,
    };
  }

  findUserIdByUlid(ulid: string): Promise<number | null> {
    return Promise.resolve(ulid === this.rider.userUlid ? this.rider.userId : null);
  }
  findRiderByUserId(userId: number): Promise<RiderRecord | null> {
    return Promise.resolve(userId === this.rider.userId ? this.rider : null);
  }
  setOnline(_userId: number, isOnline: boolean): Promise<void> {
    this.onlineWrites.push(isOnline);
    this.rider.isOnline = isOnline;
    return Promise.resolve();
  }
  recordPing(_userId: number, lat: number, lng: number): Promise<void> {
    this.pings += 1;
    this.rider.lastLat = lat;
    this.rider.lastLng = lng;
    this.rider.lastPingAt = new Date();
    return Promise.resolve();
  }
  // Unused by presence.
  createRiderProfile(): Promise<RiderRecord> {
    return Promise.reject(new Error('unused'));
  }
  findRiderByUserUlid(): Promise<RiderRecord | null> {
    return Promise.resolve(null);
  }
  setRiderStatus(_userId: number, _status: RiderStatus): Promise<void> {
    return Promise.resolve();
  }
  grantGlobalRole(): Promise<void> {
    return Promise.resolve();
  }
}

const RIDER: Actor = { ulid: 'RIDER-ULID', roles: ['rider'] };

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

function svcWith(repo: RiderRepo, pingMinIntervalSec = 10) {
  return createPresenceService({ repo, pingMinIntervalSec });
}

describe('rider presence service', () => {
  it('goes online and offline for an approved rider', async () => {
    const repo = new FakeRiderRepo();
    const svc = svcWith(repo);
    expect((await svc.goOnline(RIDER)).isOnline).toBe(true);
    expect((await svc.goOffline(RIDER)).isOnline).toBe(false);
    expect(repo.onlineWrites).toEqual([true, false]);
  });

  it('forbids a non-approved rider (403)', async () => {
    const repo = new FakeRiderRepo({ status: 'suspended' });
    const svc = svcWith(repo);
    expect(await thrownStatus(svc.goOnline(RIDER))).toBe(403);
    expect(await thrownStatus(svc.ping(RIDER, { lat: 1, lng: 2 }))).toBe(403);
  });

  it('records a first ping (no prior ping) and the coordinates', async () => {
    const repo = new FakeRiderRepo();
    const svc = svcWith(repo);
    const view = await svc.ping(RIDER, { lat: -1.0634, lng: 34.4731 });
    expect(repo.pings).toBe(1);
    expect(view.lastLat).toBe(-1.0634);
    expect(view.lastLng).toBe(34.4731);
  });

  it('throttles a ping that arrives within the min interval (no write)', async () => {
    const repo = new FakeRiderRepo({ lastPingAt: new Date(Date.now() - 2_000) }); // 2s ago
    const svc = svcWith(repo, 10); // 10s throttle
    await svc.ping(RIDER, { lat: 1, lng: 2 });
    expect(repo.pings).toBe(0); // throttled — no write
  });

  it('accepts a ping once the min interval has elapsed', async () => {
    const repo = new FakeRiderRepo({ lastPingAt: new Date(Date.now() - 20_000) }); // 20s ago
    const svc = svcWith(repo, 10);
    await svc.ping(RIDER, { lat: 1, lng: 2 });
    expect(repo.pings).toBe(1);
  });
});
