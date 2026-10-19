import { describe, expect, it } from 'vitest';
import { evaluatePromotion, type PromotionContext, type PromotionRecord } from './promotion';

function promo(over: Partial<PromotionRecord> = {}): PromotionRecord {
  return {
    id: 1,
    ulid: 'PR1',
    code: 'SAVE',
    type: 'percentage',
    valueBps: 1_000, // 10%
    valueCents: null,
    maxDiscountCents: null,
    minSubtotalCents: 0,
    perUserLimit: 1,
    totalLimit: null,
    totalRedeemed: 0,
    startsAt: new Date('2020-01-01T00:00:00Z'),
    endsAt: new Date('2999-01-01T00:00:00Z'),
    isActive: true,
    ...over,
  };
}

const CTX: PromotionContext = {
  subtotalCents: 100_000,
  deliveryFeeCents: 15_000,
  serviceFeeCents: 0,
  at: new Date('2026-06-01T00:00:00Z'),
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

describe('evaluatePromotion — discount shapes', () => {
  it('applies a percentage of the subtotal', () => {
    expect(evaluatePromotion(promo(), CTX)).toBe(10_000); // 10% of 100000
  });

  it('caps the discount at max_discount_cents', () => {
    expect(evaluatePromotion(promo({ maxDiscountCents: 5_000 }), CTX)).toBe(5_000);
  });

  it('applies a fixed amount', () => {
    expect(
      evaluatePromotion(promo({ type: 'fixed', valueBps: null, valueCents: 20_000 }), CTX),
    ).toBe(20_000);
  });

  it('applies free delivery as the delivery fee', () => {
    expect(evaluatePromotion(promo({ type: 'free_delivery', valueBps: null }), CTX)).toBe(15_000);
  });

  it('never exceeds the bill (total can never go negative)', () => {
    const d = evaluatePromotion(promo({ type: 'fixed', valueBps: null, valueCents: 999_999 }), CTX);
    expect(d).toBe(CTX.subtotalCents + CTX.deliveryFeeCents + CTX.serviceFeeCents); // 115000
  });
});

describe('evaluatePromotion — eligibility & limits', () => {
  it('rejects an inactive promotion', () => {
    expect(codeOf(() => evaluatePromotion(promo({ isActive: false }), CTX))).toBe('PROMO_INACTIVE');
  });

  it('rejects before the window starts and after it ends', () => {
    expect(codeOf(() => evaluatePromotion(promo({ startsAt: new Date('2999-01-01Z') }), CTX))).toBe(
      'PROMO_NOT_STARTED',
    );
    expect(codeOf(() => evaluatePromotion(promo({ endsAt: new Date('2021-01-01Z') }), CTX))).toBe(
      'PROMO_EXPIRED',
    );
  });

  it('rejects a subtotal below the minimum', () => {
    expect(codeOf(() => evaluatePromotion(promo({ minSubtotalCents: 200_000 }), CTX))).toBe(
      'PROMO_MIN_SUBTOTAL',
    );
  });

  it('rejects when the total limit is reached', () => {
    expect(codeOf(() => evaluatePromotion(promo({ totalLimit: 5, totalRedeemed: 5 }), CTX))).toBe(
      'PROMO_EXHAUSTED',
    );
  });

  it('enforces the per-user limit only when prior redemptions are supplied', () => {
    expect(evaluatePromotion(promo({ perUserLimit: 1 }), CTX, 0)).toBe(10_000);
    expect(codeOf(() => evaluatePromotion(promo({ perUserLimit: 1 }), CTX, 1))).toBe(
      'PROMO_USER_LIMIT',
    );
    // Without the count (quote preview), the per-user limit is not checked.
    expect(evaluatePromotion(promo({ perUserLimit: 1 }), CTX)).toBe(10_000);
  });
});
