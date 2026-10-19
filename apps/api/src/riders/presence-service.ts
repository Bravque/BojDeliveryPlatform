import { forbidden, unauthorized } from '../http/errors';
import type { RiderRecord, RiderRepo } from './repo';

/** The acting principal (from req.principal). */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface PresenceView {
  userUlid: string;
  status: RiderRecord['status'];
  isOnline: boolean;
  lastLat: number | null;
  lastLng: number | null;
}

export interface PresenceServiceDeps {
  repo: RiderRepo;
  /** Minimum seconds between accepted pings; a ping below this is a silent no-op. */
  pingMinIntervalSec: number;
}

function toView(r: RiderRecord, over: Partial<PresenceView> = {}): PresenceView {
  return {
    userUlid: r.userUlid,
    status: r.status,
    isOnline: r.isOnline,
    lastLat: r.lastLat,
    lastLng: r.lastLng,
    ...over,
  };
}

/**
 * Rider presence (doc 08 §3): online/offline + throttled location pings. Only an **approved** rider
 * may change presence; a suspended/pending profile is rejected. Candidate selection (increment 4)
 * reads `is_online` + ping freshness, so these writes are the input to assignment.
 */
export function createPresenceService(deps: PresenceServiceDeps) {
  const { repo, pingMinIntervalSec } = deps;

  async function requireApprovedRider(actor: Actor): Promise<RiderRecord> {
    const userId = await repo.findUserIdByUlid(actor.ulid);
    if (userId === null) {
      throw unauthorized('Unknown principal');
    }
    const rider = await repo.findRiderByUserId(userId);
    if (!rider || rider.status !== 'approved') {
      throw forbidden('Rider is not approved');
    }
    return rider;
  }

  async function goOnline(actor: Actor): Promise<PresenceView> {
    const rider = await requireApprovedRider(actor);
    await repo.setOnline(rider.userId, true);
    return toView(rider, { isOnline: true });
  }

  async function goOffline(actor: Actor): Promise<PresenceView> {
    const rider = await requireApprovedRider(actor);
    await repo.setOnline(rider.userId, false);
    return toView(rider, { isOnline: false });
  }

  async function ping(actor: Actor, input: { lat: number; lng: number }): Promise<PresenceView> {
    const rider = await requireApprovedRider(actor);
    // Throttle: ignore a ping that arrives within the minimum interval (no write).
    if (rider.lastPingAt) {
      const elapsedSec = (Date.now() - rider.lastPingAt.getTime()) / 1000;
      if (elapsedSec < pingMinIntervalSec) {
        return toView(rider);
      }
    }
    await repo.recordPing(rider.userId, input.lat, input.lng);
    return toView(rider, { lastLat: input.lat, lastLng: input.lng });
  }

  return { goOnline, goOffline, ping };
}

export type PresenceService = ReturnType<typeof createPresenceService>;
