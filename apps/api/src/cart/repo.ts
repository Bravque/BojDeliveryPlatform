import type { Knex } from 'knex';

/**
 * Persistence for the shopping cart, behind an interface for in-memory unit testing. The cart
 * holds references only (product + selected option ulids); prices are never stored here. Catalogue
 * reads needed to validate and display a cart (product + its option groups/options) live here too.
 */

export interface CartRecord {
  id: number;
  userId: number;
  merchantId: number | null;
}

export interface CartItemRecord {
  id: number;
  ulid: string;
  cartId: number;
  productId: number;
  quantity: number;
  optionUlids: string[];
}

/** Product fields needed to validate adding to cart (joined with its merchant). */
export interface ProductForCart {
  id: number;
  ulid: string;
  merchantId: number;
  merchantUlid: string;
  merchantName: string;
  merchantStatus: string;
  name: string;
  priceCents: number;
  currency: string;
  isAvailable: boolean;
}

export interface OptionGroupConfig {
  id: number;
  minSelect: number;
  maxSelect: number;
}

export interface OptionConfig {
  id: number;
  ulid: string;
  optionGroupId: number;
  name: string;
  priceDeltaCents: number;
  isAvailable: boolean;
}

export interface ProductBrief {
  id: number;
  ulid: string;
  name: string;
  priceCents: number;
  currency: string;
  isAvailable: boolean;
}

export interface OptionBrief {
  ulid: string;
  name: string;
  priceDeltaCents: number;
}

export interface MerchantBrief {
  ulid: string;
  name: string;
}

export interface CreateCartItemInput {
  ulid: string;
  cartId: number;
  productId: number;
  quantity: number;
  optionUlids: string[];
}

export interface CartRepo {
  findUserIdByUlid(ulid: string): Promise<number | null>;
  findCartByUserId(userId: number): Promise<CartRecord | null>;
  createCart(userId: number): Promise<CartRecord>;
  setCartMerchant(cartId: number, merchantId: number | null): Promise<void>;
  findMerchantById(merchantId: number): Promise<MerchantBrief | null>;

  findProductForCart(productUlid: string): Promise<ProductForCart | null>;
  getOptionGroups(productId: number): Promise<OptionGroupConfig[]>;
  getOptions(productId: number): Promise<OptionConfig[]>;

  listItems(cartId: number): Promise<CartItemRecord[]>;
  addItem(input: CreateCartItemInput): Promise<CartItemRecord>;
  findItemByUlid(ulid: string): Promise<CartItemRecord | null>;
  updateItemQuantity(itemId: number, quantity: number): Promise<void>;
  deleteItem(itemId: number): Promise<void>;
  deleteItemsByCart(cartId: number): Promise<void>;

  getProductsByIds(ids: number[]): Promise<ProductBrief[]>;
  getOptionsByUlids(ulids: string[]): Promise<OptionBrief[]>;
}

interface CartRowDb {
  id: number | string;
  user_id: number | string;
  merchant_id: number | string | null;
}

function mapCart(row: CartRowDb): CartRecord {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    merchantId: row.merchant_id === null ? null : Number(row.merchant_id),
  };
}

interface CartItemRowDb {
  id: number | string;
  ulid: string;
  cart_id: number | string;
  product_id: number | string;
  quantity: number | string;
  options_json: string | string[] | null;
}

/** `options_json` may arrive parsed (mysql2 JSON) or as a string, depending on driver settings. */
function parseOptionUlids(value: string | string[] | null): string[] {
  if (value === null) {
    return [];
  }
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function mapItem(row: CartItemRowDb): CartItemRecord {
  return {
    id: Number(row.id),
    ulid: row.ulid,
    cartId: Number(row.cart_id),
    productId: Number(row.product_id),
    quantity: Number(row.quantity),
    optionUlids: parseOptionUlids(row.options_json),
  };
}

export function createKnexCartRepo(db: Knex): CartRepo {
  return {
    async findUserIdByUlid(ulid) {
      const row = (await db('user').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async findCartByUserId(userId) {
      const row = (await db('cart').where({ user_id: userId }).first()) as CartRowDb | undefined;
      return row ? mapCart(row) : null;
    },

    async createCart(userId) {
      const inserted = await db('cart').insert({ user_id: userId, merchant_id: null });
      const id = inserted[0];
      if (id === undefined) {
        throw new Error('Failed to create cart');
      }
      return { id: Number(id), userId, merchantId: null };
    },

    async setCartMerchant(cartId, merchantId) {
      await db('cart').where({ id: cartId }).update({ merchant_id: merchantId });
    },

    async findMerchantById(merchantId) {
      const row = (await db('merchant').where({ id: merchantId }).first('ulid', 'name')) as
        { ulid: string; name: string } | undefined;
      return row ? { ulid: row.ulid, name: row.name } : null;
    },

    async findProductForCart(productUlid) {
      const row = (await db('product')
        .join('merchant', 'merchant.id', 'product.merchant_id')
        .where('product.ulid', productUlid)
        .first(
          'product.id as id',
          'product.ulid as ulid',
          'product.merchant_id as merchant_id',
          'merchant.ulid as merchant_ulid',
          'merchant.name as merchant_name',
          'merchant.status as merchant_status',
          'product.name as name',
          'product.price_cents as price_cents',
          'product.currency as currency',
          'product.is_available as is_available',
        )) as
        | {
            id: number | string;
            ulid: string;
            merchant_id: number | string;
            merchant_ulid: string;
            merchant_name: string;
            merchant_status: string;
            name: string;
            price_cents: number | string;
            currency: string;
            is_available: number | boolean;
          }
        | undefined;
      if (!row) {
        return null;
      }
      return {
        id: Number(row.id),
        ulid: row.ulid,
        merchantId: Number(row.merchant_id),
        merchantUlid: row.merchant_ulid,
        merchantName: row.merchant_name,
        merchantStatus: row.merchant_status,
        name: row.name,
        priceCents: Number(row.price_cents),
        currency: row.currency,
        isAvailable: Boolean(row.is_available),
      };
    },

    async getOptionGroups(productId) {
      const rows = (await db('product_option_group')
        .where({ product_id: productId })
        .select('id', 'min_select', 'max_select')) as Array<{
        id: number | string;
        min_select: number | string;
        max_select: number | string;
      }>;
      return rows.map((r) => ({
        id: Number(r.id),
        minSelect: Number(r.min_select),
        maxSelect: Number(r.max_select),
      }));
    },

    async getOptions(productId) {
      const rows = (await db('product_option')
        .join('product_option_group', 'product_option_group.id', 'product_option.option_group_id')
        .where('product_option_group.product_id', productId)
        .select(
          'product_option.id as id',
          'product_option.ulid as ulid',
          'product_option.option_group_id as option_group_id',
          'product_option.name as name',
          'product_option.price_delta_cents as price_delta_cents',
          'product_option.is_available as is_available',
        )) as Array<{
        id: number | string;
        ulid: string;
        option_group_id: number | string;
        name: string;
        price_delta_cents: number | string;
        is_available: number | boolean;
      }>;
      return rows.map((r) => ({
        id: Number(r.id),
        ulid: r.ulid,
        optionGroupId: Number(r.option_group_id),
        name: r.name,
        priceDeltaCents: Number(r.price_delta_cents),
        isAvailable: Boolean(r.is_available),
      }));
    },

    async listItems(cartId) {
      const rows = (await db('cart_item')
        .where({ cart_id: cartId })
        .orderBy('id', 'asc')) as CartItemRowDb[];
      return rows.map(mapItem);
    },

    async addItem(input) {
      const inserted = await db('cart_item').insert({
        ulid: input.ulid,
        cart_id: input.cartId,
        product_id: input.productId,
        quantity: input.quantity,
        options_json: JSON.stringify(input.optionUlids),
      });
      const id = inserted[0];
      if (id === undefined) {
        throw new Error('Failed to add cart item');
      }
      return { ...input, id: Number(id) };
    },

    async findItemByUlid(ulid) {
      const row = (await db('cart_item').where({ ulid }).first()) as CartItemRowDb | undefined;
      return row ? mapItem(row) : null;
    },

    async updateItemQuantity(itemId, quantity) {
      await db('cart_item').where({ id: itemId }).update({ quantity });
    },

    async deleteItem(itemId) {
      await db('cart_item').where({ id: itemId }).del();
    },

    async deleteItemsByCart(cartId) {
      await db('cart_item').where({ cart_id: cartId }).del();
    },

    async getProductsByIds(ids) {
      if (ids.length === 0) {
        return [];
      }
      const rows = (await db('product')
        .whereIn('id', ids)
        .select('id', 'ulid', 'name', 'price_cents', 'currency', 'is_available')) as Array<{
        id: number | string;
        ulid: string;
        name: string;
        price_cents: number | string;
        currency: string;
        is_available: number | boolean;
      }>;
      return rows.map((r) => ({
        id: Number(r.id),
        ulid: r.ulid,
        name: r.name,
        priceCents: Number(r.price_cents),
        currency: r.currency,
        isAvailable: Boolean(r.is_available),
      }));
    },

    async getOptionsByUlids(ulids) {
      if (ulids.length === 0) {
        return [];
      }
      const rows = (await db('product_option')
        .whereIn('ulid', ulids)
        .select('ulid', 'name', 'price_delta_cents')) as Array<{
        ulid: string;
        name: string;
        price_delta_cents: number | string;
      }>;
      return rows.map((r) => ({
        ulid: r.ulid,
        name: r.name,
        priceDeltaCents: Number(r.price_delta_cents),
      }));
    },
  };
}
