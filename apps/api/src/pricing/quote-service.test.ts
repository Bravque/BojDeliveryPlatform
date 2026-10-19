import { describe, expect, it } from 'vitest';
import {
  createQuoteService,
  type Actor,
  type DiscountResolver,
  type FeeResolver,
  type ZoneResolver,
} from './quote-service';
import type {
  PricingRepo,
  QuoteAddress,
  QuoteCart,
  QuoteItem,
  QuoteMerchant,
  QuoteOption,
  QuoteProduct,
} from './repo';

class FakePricingRepo implements PricingRepo {
  userId: number | null = 7;
  cart: QuoteCart | null = { id: 1, merchantId: 1 };
  items: QuoteItem[] = [{ productId: 100, quantity: 2, optionUlids: ['O1'] }];
  products: QuoteProduct[] = [
    { id: 100, ulid: 'P1', name: 'Ugali', priceCents: 15_000, isAvailable: true },
  ];
  options: QuoteOption[] = [{ ulid: 'O1', name: 'Large', priceDeltaCents: 100, isAvailable: true }];
  merchant: QuoteMerchant | null = {
    ulid: 'M1',
    name: 'Joe Kitchen',
    status: 'approved',
    lat: -1.06,
    lng: 34.47,
  };
  address: QuoteAddress | null = { id: 50, lat: -1.0634, lng: 34.4731 };

  findUserIdByUlid(): Promise<number | null> {
    return Promise.resolve(this.userId);
  }
  findCart(): Promise<QuoteCart | null> {
    return Promise.resolve(this.cart);
  }
  listItems(): Promise<QuoteItem[]> {
    return Promise.resolve(this.items);
  }
  getProducts(ids: number[]): Promise<QuoteProduct[]> {
    return Promise.resolve(this.products.filter((p) => ids.includes(p.id)));
  }
  getOptions(ulids: string[]): Promise<QuoteOption[]> {
    return Promise.resolve(this.options.filter((o) => ulids.includes(o.ulid)));
  }
  getMerchant(): Promise<QuoteMerchant | null> {
    return Promise.resolve(this.merchant);
  }
  findAddressForUser(): Promise<QuoteAddress | null> {
    return Promise.resolve(this.address);
  }
}

const zones: ZoneResolver = {
  resolveZone: () => Promise.resolve({ id: 9, ulid: 'Z1', name: 'CBD' }),
};
const fees: FeeResolver = {
  resolveFee: (_zoneId, distanceM) =>
    Promise.resolve({ feeCents: 15_000, ruleUlid: 'F1', distanceM }),
};
const noPromo: DiscountResolver = {
  resolveDiscount: () => Promise.reject(new Error('not used')),
};

const CUST: Actor = { ulid: 'cust', roles: ['customer'] };

function thrown(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number; code?: string }) => `${e.status}:${e.code}`,
  );
}

function svcWith(
  repo = new FakePricingRepo(),
  overrides: Partial<{ zones: ZoneResolver; fees: FeeResolver; promotions: DiscountResolver }> = {},
) {
  return {
    repo,
    svc: createQuoteService({
      repo,
      zones: overrides.zones ?? zones,
      fees: overrides.fees ?? fees,
      promotions: overrides.promotions ?? noPromo,
    }),
  };
}

describe('quote service', () => {
  it('recomputes the subtotal from the catalogue and totals it with delivery', async () => {
    const { svc } = svcWith();
    const q = await svc.quote(CUST, { addressUlid: 'A1' });
    // 2 × (15000 + 100) = 30200 subtotal + 15000 delivery
    expect(q.subtotalCents).toBe(30_200);
    expect(q.items[0]?.lineTotalCents).toBe(30_200);
    expect(q.deliveryFeeCents).toBe(15_000);
    expect(q.discountCents).toBe(0);
    expect(q.totalCents).toBe(45_200);
    expect(q.promotion).toBeNull();
    expect(q.zone.ulid).toBe('Z1');
  });

  it('applies a promotion discount to the total', async () => {
    const promotions: DiscountResolver = {
      resolveDiscount: () =>
        Promise.resolve({ promotion: { code: 'SAVE', type: 'percentage' }, discountCents: 3_020 }),
    };
    const { svc } = svcWith(new FakePricingRepo(), { promotions });
    const q = await svc.quote(CUST, { addressUlid: 'A1', promoCode: 'SAVE' });
    expect(q.discountCents).toBe(3_020);
    expect(q.totalCents).toBe(42_180); // 30200 + 15000 - 3020
    expect(q.promotion).toEqual({ code: 'SAVE', type: 'percentage', discountCents: 3_020 });
  });

  it('floors the total at zero (never negative)', async () => {
    const promotions: DiscountResolver = {
      resolveDiscount: () =>
        Promise.resolve({ promotion: { code: 'BIG', type: 'fixed' }, discountCents: 999_999 }),
    };
    const { svc } = svcWith(new FakePricingRepo(), { promotions });
    const q = await svc.quote(CUST, { addressUlid: 'A1', promoCode: 'BIG' });
    expect(q.totalCents).toBe(0);
  });

  it('blocks an out-of-zone address with 422 OUT_OF_ZONE', async () => {
    const { svc } = svcWith(new FakePricingRepo(), {
      zones: { resolveZone: () => Promise.resolve(null) },
    });
    expect(await thrown(svc.quote(CUST, { addressUlid: 'A1' }))).toBe('422:OUT_OF_ZONE');
  });

  it('422s when no delivery fee rule is in force', async () => {
    const { svc } = svcWith(new FakePricingRepo(), {
      fees: { resolveFee: () => Promise.resolve(null) },
    });
    expect(await thrown(svc.quote(CUST, { addressUlid: 'A1' }))).toBe(
      '422:DELIVERY_FEE_UNAVAILABLE',
    );
  });

  it('422s an unavailable item', async () => {
    const repo = new FakePricingRepo();
    repo.products = [
      { id: 100, ulid: 'P1', name: 'Ugali', priceCents: 15_000, isAvailable: false },
    ];
    const { svc } = svcWith(repo);
    expect(await thrown(svc.quote(CUST, { addressUlid: 'A1' }))).toBe('422:ITEM_UNAVAILABLE');
  });

  it('422s an empty cart and 404s an unknown address', async () => {
    const empty = new FakePricingRepo();
    empty.cart = { id: 1, merchantId: null };
    expect(await thrown(svcWith(empty).svc.quote(CUST, { addressUlid: 'A1' }))).toBe(
      '422:CART_EMPTY',
    );

    const noAddr = new FakePricingRepo();
    noAddr.address = null;
    expect(await thrown(svcWith(noAddr).svc.quote(CUST, { addressUlid: 'A1' }))).toBe(
      '404:NOT_FOUND',
    );
  });

  it('422s a non-approved merchant and 401s an unknown principal', async () => {
    const suspended = new FakePricingRepo();
    suspended.merchant = { ulid: 'M1', name: 'Joe', status: 'suspended', lat: null, lng: null };
    expect(await thrown(svcWith(suspended).svc.quote(CUST, { addressUlid: 'A1' }))).toBe(
      '422:MERCHANT_UNAVAILABLE',
    );

    const ghost = new FakePricingRepo();
    ghost.userId = null;
    expect(await thrown(svcWith(ghost).svc.quote(CUST, { addressUlid: 'A1' }))).toBe(
      '401:UNAUTHORIZED',
    );
  });
});
