import { haversineMeters, type LatLng } from '../geo/distance';

/** A rider eligible for ranking: already filtered to approved + online + fresh + not-busy by the repo. */
export interface Candidate {
  userId: number;
  lat: number;
  lng: number;
}

/**
 * Rank candidate riders for an order (doc 08 §2.1): keep only those within `maxRadiusM` of the
 * merchant, nearest first. Pure — the DB filters eligibility (approved/online/fresh/not-busy); this
 * applies the distance cap + ordering. Tie-breakers (acceptance rate, idle time) can be layered in
 * later without changing the call site.
 */
export function rankCandidates(
  candidates: Candidate[],
  merchant: LatLng,
  maxRadiusM: number,
): number[] {
  return candidates
    .map((c) => ({
      userId: c.userId,
      distance: haversineMeters(merchant, { lat: c.lat, lng: c.lng }),
    }))
    .filter((c) => c.distance <= maxRadiusM)
    .sort((a, b) => a.distance - b.distance)
    .map((c) => c.userId);
}
