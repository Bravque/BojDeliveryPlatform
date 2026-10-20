import { describe, expect, it } from 'vitest';
import { rankCandidates, type Candidate } from './candidate';

const MERCHANT = { lat: 0, lng: 0 };
// At the equator/prime meridian, 0.01° ≈ 1.11 km and 0.1° ≈ 11.1 km north.
const near: Candidate = { userId: 1, lat: 0, lng: 0 }; // 0 m
const mid: Candidate = { userId: 2, lat: 0.01, lng: 0 }; // ~1.1 km
const far: Candidate = { userId: 3, lat: 0.1, lng: 0 }; // ~11 km

describe('rankCandidates', () => {
  it('orders by distance (nearest first) and filters beyond the radius', () => {
    expect(rankCandidates([far, near, mid], MERCHANT, 3_000)).toEqual([1, 2]);
  });

  it('keeps everyone within a generous radius', () => {
    expect(rankCandidates([far, near, mid], MERCHANT, 50_000)).toEqual([1, 2, 3]);
  });

  it('returns empty when all candidates are out of range', () => {
    expect(rankCandidates([far], MERCHANT, 1_000)).toEqual([]);
  });

  it('returns empty for no candidates', () => {
    expect(rankCandidates([], MERCHANT, 10_000)).toEqual([]);
  });
});
