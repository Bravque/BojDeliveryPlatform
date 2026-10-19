import { addCents } from '@boj/money';
import { unprocessable } from '../http/errors';

/**
 * Pure line-pricing, shared by the quote (preview) and order creation (snapshot) so the two can
 * never disagree. A line total is `(unit price + Σ option deltas) × quantity`; an unavailable
 * product or option is rejected with a 422 `ITEM_UNAVAILABLE`.
 */

export interface PriceableProduct {
  ulid: string;
  name: string;
  priceCents: number;
  isAvailable: boolean;
}

export interface PriceableOption {
  ulid: string;
  name: string;
  priceDeltaCents: number;
  isAvailable: boolean;
}

export interface PricedLine {
  productUlid: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  optionsCents: number;
  lineTotalCents: number;
  options: Array<{ ulid: string; name: string; priceDeltaCents: number }>;
}

export function priceLine(
  product: PriceableProduct,
  quantity: number,
  options: PriceableOption[],
): PricedLine {
  if (!product.isAvailable) {
    throw unprocessable('ITEM_UNAVAILABLE', 'A product in the cart is no longer available');
  }
  for (const option of options) {
    if (!option.isAvailable) {
      throw unprocessable('ITEM_UNAVAILABLE', 'A selected option is no longer available');
    }
  }
  const optionsCents = addCents(...options.map((o) => o.priceDeltaCents));
  const lineTotalCents = (product.priceCents + optionsCents) * quantity;
  return {
    productUlid: product.ulid,
    name: product.name,
    unitPriceCents: product.priceCents,
    quantity,
    optionsCents,
    lineTotalCents,
    options: options.map((o) => ({
      ulid: o.ulid,
      name: o.name,
      priceDeltaCents: o.priceDeltaCents,
    })),
  };
}

export function sumSubtotalCents(lines: PricedLine[]): number {
  return addCents(...lines.map((l) => l.lineTotalCents));
}
