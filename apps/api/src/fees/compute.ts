import { addCents, assertInteger, clampCents } from '@boj/money';
import { haversineMeters, type LatLng } from '../geo/distance';

/**
 * Delivery-fee computation (D3). Pure integer-cents arithmetic via `@boj/money`, kept separate
 * from persistence so the formula is trivially unit-testable and is the single definition reused
 * by the quote/checkout flow in later increments.
 */

/** The fee-shaping fields of a delivery-fee rule. */
export interface FeeInputs {
  baseFeeCents: number;
  perKmCents: number;
  minFeeCents: number;
  maxFeeCents: number | null;
}

/**
 * `clamp(base + round(per_km × km), min, max)`. `distanceM` is the straight-line distance in
 * metres (D11 — a routing provider can replace the distance source later without touching this).
 */
export function computeDeliveryFeeCents(rule: FeeInputs, distanceM: number): number {
  if (!Number.isFinite(distanceM) || distanceM < 0) {
    throw new RangeError(`distanceM must be a non-negative finite number, received: ${distanceM}`);
  }
  const km = distanceM / 1000;
  const distanceComponent = Math.round(rule.perKmCents * km);
  assertInteger(distanceComponent);
  const raw = addCents(rule.baseFeeCents, distanceComponent);
  return clampCents(raw, rule.minFeeCents, rule.maxFeeCents ?? undefined);
}

/** Straight-line delivery distance in whole metres (matches `order.distance_m`, an INT). */
export function distanceMeters(from: LatLng, to: LatLng): number {
  return Math.round(haversineMeters(from, to));
}
