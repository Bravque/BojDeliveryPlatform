import { addCents, CURRENCY } from '@boj/money';
import { notFound, unauthorized, unprocessable } from '../http/errors';
import { distanceMeters } from '../fees/compute';
import type { PromotionType } from '../promotions/promotion';
import type { PricingRepo, QuoteOption, QuoteProduct } from './repo';

/** The acting principal (from req.principal). Quotes are scoped to this user's cart + addresses. */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface QuoteInput {
  addressUlid: string;
  promoCode?: string;
}

export interface QuoteLineItem {
  productUlid: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  optionsCents: number;
  lineTotalCents: number;
  options: Array<{ ulid: string; name: string; priceDeltaCents: number }>;
}

export interface QuoteBreakdown {
  merchant: { ulid: string; name: string };
  zone: { ulid: string; name: string };
  distanceM: number;
  currency: string;
  items: QuoteLineItem[];
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  discountCents: number;
  totalCents: number;
  promotion: { code: string; type: PromotionType; discountCents: number } | null;
}

/** Narrow collaborators (satisfied structurally by ZoneService/FeeService/PromotionService). */
export interface ZoneResolver {
  resolveZone(lat: number, lng: number): Promise<{ id: number; ulid: string; name: string } | null>;
}
export interface FeeResolver {
  resolveFee(
    zoneId: number,
    distanceM: number,
    at?: Date,
  ): Promise<{ feeCents: number; ruleUlid: string; distanceM: number } | null>;
}
export interface DiscountResolver {
  resolveDiscount(
    code: string,
    ctx: { subtotalCents: number; deliveryFeeCents: number; serviceFeeCents: number; at: Date },
    priorUserRedemptions?: number,
  ): Promise<{ promotion: { code: string; type: PromotionType }; discountCents: number }>;
}

export interface QuoteServiceDeps {
  repo: PricingRepo;
  zones: ZoneResolver;
  fees: FeeResolver;
  promotions: DiscountResolver;
}

/** Platform service fee (configurable); 0 at launch. */
const SERVICE_FEE_CENTS = 0;

export function createQuoteService(deps: QuoteServiceDeps) {
  const { repo, zones, fees, promotions } = deps;

  async function requireUserId(actor: Actor): Promise<number> {
    const userId = await repo.findUserIdByUlid(actor.ulid);
    if (userId === null) {
      throw unauthorized('Unknown principal');
    }
    return userId;
  }

  async function quote(actor: Actor, input: QuoteInput): Promise<QuoteBreakdown> {
    const userId = await requireUserId(actor);

    const cart = await repo.findCart(userId);
    if (!cart || cart.merchantId === null) {
      throw unprocessable('CART_EMPTY', 'Cart is empty');
    }
    const items = await repo.listItems(cart.id);
    if (items.length === 0) {
      throw unprocessable('CART_EMPTY', 'Cart is empty');
    }

    const address = await repo.findAddressForUser(input.addressUlid, userId);
    if (!address) {
      throw notFound('Address not found');
    }

    const merchant = await repo.getMerchant(cart.merchantId);
    if (!merchant || merchant.status !== 'approved') {
      throw unprocessable('MERCHANT_UNAVAILABLE', 'Merchant is not available');
    }

    // Recompute line items from the catalogue — never from the cart.
    const products = new Map<number, QuoteProduct>(
      (await repo.getProducts([...new Set(items.map((i) => i.productId))])).map((p) => [p.id, p]),
    );
    const options = new Map<string, QuoteOption>(
      (await repo.getOptions([...new Set(items.flatMap((i) => i.optionUlids))])).map((o) => [
        o.ulid,
        o,
      ]),
    );

    const lineItems: QuoteLineItem[] = items.map((item) => {
      const product = products.get(item.productId);
      if (!product || !product.isAvailable) {
        throw unprocessable('ITEM_UNAVAILABLE', 'A product in the cart is no longer available');
      }
      const selected = item.optionUlids.map((ulid) => {
        const option = options.get(ulid);
        if (!option || !option.isAvailable) {
          throw unprocessable('ITEM_UNAVAILABLE', 'A selected option is no longer available');
        }
        return option;
      });
      const optionsCents = addCents(...selected.map((o) => o.priceDeltaCents));
      const lineTotalCents = (product.priceCents + optionsCents) * item.quantity;
      return {
        productUlid: product.ulid,
        name: product.name,
        unitPriceCents: product.priceCents,
        quantity: item.quantity,
        optionsCents,
        lineTotalCents,
        options: selected.map((o) => ({
          ulid: o.ulid,
          name: o.name,
          priceDeltaCents: o.priceDeltaCents,
        })),
      };
    });

    const subtotalCents = addCents(...lineItems.map((l) => l.lineTotalCents));

    // Serviceable zone (re-resolved from the point, authoritative) → delivery fee.
    const zone = await zones.resolveZone(address.lat, address.lng);
    if (!zone) {
      throw unprocessable('OUT_OF_ZONE', 'This address is outside our delivery area');
    }
    const distanceM =
      merchant.lat !== null && merchant.lng !== null
        ? distanceMeters(
            { lat: merchant.lat, lng: merchant.lng },
            { lat: address.lat, lng: address.lng },
          )
        : 0;
    const feeQuote = await fees.resolveFee(zone.id, distanceM);
    if (!feeQuote) {
      throw unprocessable('DELIVERY_FEE_UNAVAILABLE', 'Delivery is not priced for this area');
    }
    const deliveryFeeCents = feeQuote.feeCents;
    const serviceFeeCents = SERVICE_FEE_CENTS;

    // Promotion (preview only — no redemption here).
    let discountCents = 0;
    let promotion: QuoteBreakdown['promotion'] = null;
    if (input.promoCode) {
      const resolved = await promotions.resolveDiscount(input.promoCode, {
        subtotalCents,
        deliveryFeeCents,
        serviceFeeCents,
        at: new Date(),
      });
      discountCents = resolved.discountCents;
      promotion = {
        code: resolved.promotion.code,
        type: resolved.promotion.type,
        discountCents,
      };
    }

    const totalCents = Math.max(
      0,
      subtotalCents + deliveryFeeCents + serviceFeeCents - discountCents,
    );

    return {
      merchant: { ulid: merchant.ulid, name: merchant.name },
      zone: { ulid: zone.ulid, name: zone.name },
      distanceM,
      currency: CURRENCY,
      items: lineItems,
      subtotalCents,
      deliveryFeeCents,
      serviceFeeCents,
      discountCents,
      totalCents,
      promotion,
    };
  }

  return { quote };
}

export type QuoteService = ReturnType<typeof createQuoteService>;
