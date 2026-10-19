/**
 * Great-circle distance between two WGS-84 points (the haversine formula), returned in metres.
 *
 * Used for zone resolution (is a point within a zone's radius?) and, from Phase 3 increment 2,
 * the delivery-fee distance (merchant → delivery address). This straight-line distance is the
 * launch approach (D11); a real road-distance provider can replace the call sites later without
 * changing their shape.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000; // mean Earth radius

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Distance in metres between two points. Symmetric; returns 0 for identical points. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
