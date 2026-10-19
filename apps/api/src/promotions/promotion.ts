import { applyBps } from '@boj/money';
import { unprocessable } from '../http/errors';

/**
 * Pure promotion evaluation (eligibility + discount), separate from persistence so the rules are
 * trivially unit-testable and are the single definition reused by the quote (preview) and by
 * checkout (increment 5, which also records the redemption). Discount is always `>= 0` and never
 * exceeds the bill, so the order total can never go negative.
 */

export type PromotionType = 'percentage' | 'fixed' | 'free_delivery';

export interface PromotionRecord {
  id: number;
  ulid: string;
  code: string;
  type: PromotionType;
  valueBps: number | null;
  valueCents: number | null;
  maxDiscountCents: number | null;
  minSubtotalCents: number;
  perUserLimit: number;
  totalLimit: number | null;
  totalRedeemed: number;
  startsAt: Date;
  endsAt: Date;
  isActive: boolean;
}

export interface PromotionContext {
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  at: Date;
}

/**
 * Validate eligibility and compute the capped discount in cents, or throw a 422 with a specific
 * code. `priorUserRedemptions` enforces the per-user limit when supplied (checkout); the quote
 * omits it (the redemption table arrives in increment 5).
 */
export function evaluatePromotion(
  promo: PromotionRecord,
  ctx: PromotionContext,
  priorUserRedemptions?: number,
): number {
  if (!promo.isActive) {
    throw unprocessable('PROMO_INACTIVE', 'Promotion is not active');
  }
  if (ctx.at.getTime() < promo.startsAt.getTime()) {
    throw unprocessable('PROMO_NOT_STARTED', 'Promotion has not started');
  }
  if (ctx.at.getTime() >= promo.endsAt.getTime()) {
    throw unprocessable('PROMO_EXPIRED', 'Promotion has expired');
  }
  if (ctx.subtotalCents < promo.minSubtotalCents) {
    throw unprocessable('PROMO_MIN_SUBTOTAL', 'Order subtotal is below the promotion minimum');
  }
  if (promo.totalLimit !== null && promo.totalRedeemed >= promo.totalLimit) {
    throw unprocessable('PROMO_EXHAUSTED', 'Promotion has been fully redeemed');
  }
  if (priorUserRedemptions !== undefined && priorUserRedemptions >= promo.perUserLimit) {
    throw unprocessable('PROMO_USER_LIMIT', 'Promotion already used the maximum number of times');
  }

  let raw: number;
  switch (promo.type) {
    case 'percentage':
      raw = applyBps(ctx.subtotalCents, promo.valueBps ?? 0);
      break;
    case 'fixed':
      raw = promo.valueCents ?? 0;
      break;
    case 'free_delivery':
      raw = ctx.deliveryFeeCents;
      break;
  }

  if (promo.maxDiscountCents !== null) {
    raw = Math.min(raw, promo.maxDiscountCents);
  }
  const bill = ctx.subtotalCents + ctx.deliveryFeeCents + ctx.serviceFeeCents;
  return Math.max(0, Math.min(raw, bill));
}
