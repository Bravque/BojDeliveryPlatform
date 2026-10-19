import type { Knex } from 'knex';

/**
 * Read model for quoting. Deliberately re-reads product/option prices and availability from the
 * catalogue (never the cart) so a quote is server-authoritative and deterministic.
 */

export interface QuoteCart {
  id: number;
  merchantId: number | null;
}

export interface QuoteItem {
  productId: number;
  quantity: number;
  optionUlids: string[];
}

export interface QuoteProduct {
  id: number;
  ulid: string;
  name: string;
  priceCents: number;
  isAvailable: boolean;
}

export interface QuoteOption {
  ulid: string;
  name: string;
  priceDeltaCents: number;
  isAvailable: boolean;
}

export interface QuoteMerchant {
  ulid: string;
  name: string;
  status: string;
  lat: number | null;
  lng: number | null;
}

export interface QuoteAddress {
  id: number;
  lat: number;
  lng: number;
}

export interface PricingRepo {
  findUserIdByUlid(ulid: string): Promise<number | null>;
  findCart(userId: number): Promise<QuoteCart | null>;
  listItems(cartId: number): Promise<QuoteItem[]>;
  getProducts(ids: number[]): Promise<QuoteProduct[]>;
  getOptions(ulids: string[]): Promise<QuoteOption[]>;
  getMerchant(merchantId: number): Promise<QuoteMerchant | null>;
  findAddressForUser(addressUlid: string, userId: number): Promise<QuoteAddress | null>;
}

function parseOptionUlids(value: string | string[] | null): string[] {
  if (value === null) {
    return [];
  }
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

export function createKnexPricingRepo(db: Knex): PricingRepo {
  return {
    async findUserIdByUlid(ulid) {
      const row = (await db('user').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async findCart(userId) {
      const row = (await db('cart').where({ user_id: userId }).first('id', 'merchant_id')) as
        { id: number | string; merchant_id: number | string | null } | undefined;
      if (!row) {
        return null;
      }
      return {
        id: Number(row.id),
        merchantId: row.merchant_id === null ? null : Number(row.merchant_id),
      };
    },

    async listItems(cartId) {
      const rows = (await db('cart_item')
        .where({ cart_id: cartId })
        .orderBy('id', 'asc')
        .select('product_id', 'quantity', 'options_json')) as Array<{
        product_id: number | string;
        quantity: number | string;
        options_json: string | string[] | null;
      }>;
      return rows.map((r) => ({
        productId: Number(r.product_id),
        quantity: Number(r.quantity),
        optionUlids: parseOptionUlids(r.options_json),
      }));
    },

    async getProducts(ids) {
      if (ids.length === 0) {
        return [];
      }
      const rows = (await db('product')
        .whereIn('id', ids)
        .select('id', 'ulid', 'name', 'price_cents', 'is_available')) as Array<{
        id: number | string;
        ulid: string;
        name: string;
        price_cents: number | string;
        is_available: number | boolean;
      }>;
      return rows.map((r) => ({
        id: Number(r.id),
        ulid: r.ulid,
        name: r.name,
        priceCents: Number(r.price_cents),
        isAvailable: Boolean(r.is_available),
      }));
    },

    async getOptions(ulids) {
      if (ulids.length === 0) {
        return [];
      }
      const rows = (await db('product_option')
        .whereIn('ulid', ulids)
        .select('ulid', 'name', 'price_delta_cents', 'is_available')) as Array<{
        ulid: string;
        name: string;
        price_delta_cents: number | string;
        is_available: number | boolean;
      }>;
      return rows.map((r) => ({
        ulid: r.ulid,
        name: r.name,
        priceDeltaCents: Number(r.price_delta_cents),
        isAvailable: Boolean(r.is_available),
      }));
    },

    async getMerchant(merchantId) {
      const row = (await db('merchant')
        .where({ id: merchantId })
        .first('ulid', 'name', 'status', 'lat', 'lng')) as
        | {
            ulid: string;
            name: string;
            status: string;
            lat: string | number | null;
            lng: string | number | null;
          }
        | undefined;
      if (!row) {
        return null;
      }
      return {
        ulid: row.ulid,
        name: row.name,
        status: row.status,
        lat: row.lat === null ? null : Number(row.lat),
        lng: row.lng === null ? null : Number(row.lng),
      };
    },

    async findAddressForUser(addressUlid, userId) {
      const row = (await db('address')
        .where({ ulid: addressUlid, user_id: userId })
        .first('id', 'lat', 'lng')) as
        { id: number | string; lat: string | number; lng: string | number } | undefined;
      if (!row) {
        return null;
      }
      return { id: Number(row.id), lat: Number(row.lat), lng: Number(row.lng) };
    },
  };
}
