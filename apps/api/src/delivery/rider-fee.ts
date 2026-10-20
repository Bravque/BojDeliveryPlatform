/**
 * Rider earning per delivery (decision **D15**): a configurable rate, with the platform keeping the
 * margin between the customer's delivery fee and the rider's fee. The fee is capped at the delivery
 * fee so a rider never earns more than the customer paid for delivery (margin ≥ 0). This is the one
 * place the D5 policy lives — swapping to a per-zone rate or a distance formula is a change here
 * only; the call site (the accept transaction) stays the same.
 */
export function computeRiderFeeCents(deliveryFeeCents: number, flatRateCents: number): number {
  return Math.max(0, Math.min(flatRateCents, deliveryFeeCents));
}
