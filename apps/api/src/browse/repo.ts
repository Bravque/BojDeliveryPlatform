import type { Knex } from 'knex';

/**
 * Read-only persistence for the public catalogue (doc 05). Only **approved + open** merchants and
 * **available** products/options are ever returned; the filters live in SQL so a closed/pending
 * merchant or an unavailable product can never leak to customers. Towns now carry a stable public
 * `ulid` (added with zones in Phase 3) alongside the display name.
 */

export interface TownItem {
  ulid: string;
  name: string;
  timezone: string;
}

export interface MerchantListItem {
  ulid: string;
  name: string;
  categoryType: string;
  prepMinutes: number;
  isOpen: boolean;
  townName: string;
}

export interface MerchantDetail extends MerchantListItem {
  id: number;
  status: string;
}

export interface BrowseCategory {
  id: number;
  ulid: string;
  name: string;
  sortOrder: number;
}

export interface BrowseProduct {
  id: number;
  ulid: string;
  categoryId: number | null;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
}

export interface BrowseOptionGroup {
  id: number;
  productId: number;
  ulid: string;
  name: string;
  minSelect: number;
  maxSelect: number;
}

export interface BrowseOption {
  optionGroupId: number;
  ulid: string;
  name: string;
  priceDeltaCents: number;
}

export interface ProductDetail {
  id: number;
  ulid: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  merchantUlid: string;
}

export interface MerchantFilters {
  townName?: string;
  category?: string;
}

export interface BrowseRepo {
  listActiveTowns(): Promise<TownItem[]>;
  listMerchants(filters: MerchantFilters): Promise<MerchantListItem[]>;
  findApprovedMerchant(ulid: string): Promise<MerchantDetail | null>;
  listActiveCategories(merchantId: number): Promise<BrowseCategory[]>;
  listAvailableProducts(merchantId: number): Promise<BrowseProduct[]>;
  listOptionGroups(productIds: number[]): Promise<BrowseOptionGroup[]>;
  listAvailableOptions(groupIds: number[]): Promise<BrowseOption[]>;
  findAvailableProduct(ulid: string): Promise<ProductDetail | null>;
}

interface TownRow {
  ulid: string;
  name: string;
  timezone: string;
}
interface MerchantRow {
  id?: number | string;
  ulid: string;
  name: string;
  category_type: string;
  prep_minutes: number | string;
  is_open: number | boolean;
  status?: string;
  town_name: string;
}
interface CategoryRow {
  id: number | string;
  ulid: string;
  name: string;
  sort_order: number | string;
}
interface ProductRow {
  id: number | string;
  ulid: string;
  category_id: number | string | null;
  name: string;
  description: string | null;
  price_cents: number | string;
  currency: string;
}
interface GroupRow {
  id: number | string;
  product_id: number | string;
  ulid: string;
  name: string;
  min_select: number | string;
  max_select: number | string;
}
interface OptionRow {
  option_group_id: number | string;
  ulid: string;
  name: string;
  price_delta_cents: number | string;
}
interface ProductDetailRow extends ProductRow {
  merchant_ulid: string;
}

function mapMerchantListItem(r: MerchantRow): MerchantListItem {
  return {
    ulid: r.ulid,
    name: r.name,
    categoryType: r.category_type,
    prepMinutes: Number(r.prep_minutes),
    isOpen: Boolean(r.is_open),
    townName: r.town_name,
  };
}

export function createKnexBrowseRepo(db: Knex): BrowseRepo {
  return {
    async listActiveTowns() {
      const rows = (await db('town')
        .where('is_active', true)
        .orderBy('name')
        .select('ulid', 'name', 'timezone')) as TownRow[];
      return rows.map((r) => ({ ulid: r.ulid, name: r.name, timezone: r.timezone }));
    },

    async listMerchants(filters) {
      const q = db('merchant')
        .join('town', 'town.id', 'merchant.town_id')
        .where('merchant.status', 'approved')
        .where('merchant.is_open', true);
      if (filters.townName) {
        q.where('town.name', filters.townName);
      }
      if (filters.category) {
        q.where('merchant.category_type', filters.category);
      }
      const rows = (await q
        .orderBy('merchant.name')
        .select(
          'merchant.ulid as ulid',
          'merchant.name as name',
          'merchant.category_type as category_type',
          'merchant.prep_minutes as prep_minutes',
          'merchant.is_open as is_open',
          'town.name as town_name',
        )) as MerchantRow[];
      return rows.map(mapMerchantListItem);
    },

    async findApprovedMerchant(ulid) {
      const r = (await db('merchant')
        .join('town', 'town.id', 'merchant.town_id')
        .where('merchant.ulid', ulid)
        .where('merchant.status', 'approved')
        .first(
          'merchant.id as id',
          'merchant.ulid as ulid',
          'merchant.name as name',
          'merchant.category_type as category_type',
          'merchant.prep_minutes as prep_minutes',
          'merchant.is_open as is_open',
          'merchant.status as status',
          'town.name as town_name',
        )) as MerchantRow | undefined;
      return r
        ? { id: Number(r.id), status: r.status ?? 'approved', ...mapMerchantListItem(r) }
        : null;
    },

    async listActiveCategories(merchantId) {
      const rows = (await db('category')
        .where({ merchant_id: merchantId, is_active: true })
        .orderBy('sort_order')
        .select('id', 'ulid', 'name', 'sort_order')) as CategoryRow[];
      return rows.map((r) => ({
        id: Number(r.id),
        ulid: r.ulid,
        name: r.name,
        sortOrder: Number(r.sort_order),
      }));
    },

    async listAvailableProducts(merchantId) {
      const rows = (await db('product')
        .where({ merchant_id: merchantId, is_available: true })
        .orderBy('name')
        .select(
          'id',
          'ulid',
          'category_id',
          'name',
          'description',
          'price_cents',
          'currency',
        )) as ProductRow[];
      return rows.map((r) => ({
        id: Number(r.id),
        ulid: r.ulid,
        categoryId: r.category_id === null ? null : Number(r.category_id),
        name: r.name,
        description: r.description ?? null,
        priceCents: Number(r.price_cents),
        currency: r.currency,
      }));
    },

    async listOptionGroups(productIds) {
      if (productIds.length === 0) {
        return [];
      }
      const rows = (await db('product_option_group')
        .whereIn('product_id', productIds)
        .select('id', 'product_id', 'ulid', 'name', 'min_select', 'max_select')) as GroupRow[];
      return rows.map((r) => ({
        id: Number(r.id),
        productId: Number(r.product_id),
        ulid: r.ulid,
        name: r.name,
        minSelect: Number(r.min_select),
        maxSelect: Number(r.max_select),
      }));
    },

    async listAvailableOptions(groupIds) {
      if (groupIds.length === 0) {
        return [];
      }
      const rows = (await db('product_option')
        .whereIn('option_group_id', groupIds)
        .where('is_available', true)
        .select('option_group_id', 'ulid', 'name', 'price_delta_cents')) as OptionRow[];
      return rows.map((r) => ({
        optionGroupId: Number(r.option_group_id),
        ulid: r.ulid,
        name: r.name,
        priceDeltaCents: Number(r.price_delta_cents),
      }));
    },

    async findAvailableProduct(ulid) {
      const r = (await db('product')
        .join('merchant', 'merchant.id', 'product.merchant_id')
        .where('product.ulid', ulid)
        .where('product.is_available', true)
        .where('merchant.status', 'approved')
        .first(
          'product.id as id',
          'product.ulid as ulid',
          'product.name as name',
          'product.description as description',
          'product.price_cents as price_cents',
          'product.currency as currency',
          'merchant.ulid as merchant_ulid',
        )) as ProductDetailRow | undefined;
      return r
        ? {
            id: Number(r.id),
            ulid: r.ulid,
            name: r.name,
            description: r.description ?? null,
            priceCents: Number(r.price_cents),
            currency: r.currency,
            merchantUlid: r.merchant_ulid,
          }
        : null;
    },
  };
}
