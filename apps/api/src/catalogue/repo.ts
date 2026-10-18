import type { Knex } from 'knex';

/**
 * Persistence for the merchant-facing catalogue. Behind an interface for unit testing; the Knex
 * implementation is thin. Product edits use an optimistic lock: `updateProductWithVersion`
 * updates only when the stored `version` matches, bumping it — the caller treats a no-op as a
 * concurrency conflict.
 */

/** The merchant a principal belongs to (resolved via merchant_user). */
export interface MerchantContext {
  merchantId: number;
  merchantUlid: string;
}

export interface CategoryRecord {
  id: number;
  ulid: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface ProductRecord {
  id: number;
  ulid: string;
  merchantId: number;
  categoryId: number | null;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  isAvailable: boolean;
  version: number;
}

export interface ProductPatch {
  name?: string;
  description?: string | null;
  priceCents?: number;
  categoryId?: number | null;
}

export interface CatalogueRepo {
  findMerchantContextForUserUlid(userUlid: string): Promise<MerchantContext | null>;
  createCategory(
    merchantId: number,
    input: { ulid: string; name: string; sortOrder: number },
  ): Promise<CategoryRecord>;
  findCategoryIdByUlidForMerchant(merchantId: number, ulid: string): Promise<number | null>;
  createProduct(
    merchantId: number,
    input: {
      ulid: string;
      categoryId: number | null;
      name: string;
      description: string | null;
      priceCents: number;
    },
  ): Promise<ProductRecord>;
  findProductByUlid(ulid: string): Promise<ProductRecord | null>;
  /** Returns the updated product, or null if `expectedVersion` did not match (conflict). */
  updateProductWithVersion(
    productId: number,
    expectedVersion: number,
    patch: ProductPatch,
  ): Promise<ProductRecord | null>;
  setProductAvailability(productId: number, isAvailable: boolean): Promise<void>;
  updateMerchantProfile(
    merchantId: number,
    patch: { isOpen?: boolean; prepMinutes?: number },
  ): Promise<void>;
}

interface CategoryRowDb {
  id: number | string;
  ulid: string;
  name: string;
  sort_order: number | string;
  is_active: number | boolean;
}

interface ProductRowDb {
  id: number | string;
  ulid: string;
  merchant_id: number | string;
  category_id: number | string | null;
  name: string;
  description: string | null;
  price_cents: number | string;
  currency: string;
  is_available: number | boolean;
  version: number | string;
}

function mapCategory(row: CategoryRowDb): CategoryRecord {
  return {
    id: Number(row.id),
    ulid: row.ulid,
    name: row.name,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
  };
}

function mapProduct(row: ProductRowDb): ProductRecord {
  return {
    id: Number(row.id),
    ulid: row.ulid,
    merchantId: Number(row.merchant_id),
    categoryId: row.category_id === null ? null : Number(row.category_id),
    name: row.name,
    description: row.description ?? null,
    priceCents: Number(row.price_cents),
    currency: row.currency,
    isAvailable: Boolean(row.is_available),
    version: Number(row.version),
  };
}

export function createKnexCatalogueRepo(db: Knex): CatalogueRepo {
  async function productById(id: number): Promise<ProductRecord> {
    const row = (await db('product').where({ id }).first()) as ProductRowDb;
    return mapProduct(row);
  }

  return {
    async findMerchantContextForUserUlid(userUlid) {
      const row = (await db('merchant_user')
        .join('user', 'user.id', 'merchant_user.user_id')
        .join('merchant', 'merchant.id', 'merchant_user.merchant_id')
        .where('user.ulid', userUlid)
        .first('merchant.id as merchant_id', 'merchant.ulid as merchant_ulid')) as
        { merchant_id: number | string; merchant_ulid: string } | undefined;
      return row ? { merchantId: Number(row.merchant_id), merchantUlid: row.merchant_ulid } : null;
    },

    async createCategory(merchantId, input) {
      const inserted = await db('category').insert({
        ulid: input.ulid,
        merchant_id: merchantId,
        name: input.name,
        sort_order: input.sortOrder,
      });
      const id = inserted[0];
      if (id === undefined) {
        throw new Error('Failed to create category');
      }
      const row = (await db('category').where({ id }).first()) as CategoryRowDb;
      return mapCategory(row);
    },

    async findCategoryIdByUlidForMerchant(merchantId, ulid) {
      const row = (await db('category').where({ ulid, merchant_id: merchantId }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async createProduct(merchantId, input) {
      const inserted = await db('product').insert({
        ulid: input.ulid,
        merchant_id: merchantId,
        category_id: input.categoryId,
        name: input.name,
        description: input.description,
        price_cents: input.priceCents,
      });
      const id = inserted[0];
      if (id === undefined) {
        throw new Error('Failed to create product');
      }
      return productById(id);
    },

    async findProductByUlid(ulid) {
      const row = (await db('product').where({ ulid }).first()) as ProductRowDb | undefined;
      return row ? mapProduct(row) : null;
    },

    async updateProductWithVersion(productId, expectedVersion, patch) {
      const update: Record<string, unknown> = { version: db.raw('version + 1') };
      if (patch.name !== undefined) update.name = patch.name;
      if (patch.description !== undefined) update.description = patch.description;
      if (patch.priceCents !== undefined) update.price_cents = patch.priceCents;
      if (patch.categoryId !== undefined) update.category_id = patch.categoryId;

      const affected = await db('product')
        .where({ id: productId, version: expectedVersion })
        .update(update);
      if (affected === 0) {
        return null;
      }
      return productById(productId);
    },

    async setProductAvailability(productId, isAvailable) {
      await db('product').where({ id: productId }).update({ is_available: isAvailable });
    },

    async updateMerchantProfile(merchantId, patch) {
      const update: Record<string, unknown> = {};
      if (patch.isOpen !== undefined) update.is_open = patch.isOpen;
      if (patch.prepMinutes !== undefined) update.prep_minutes = patch.prepMinutes;
      if (Object.keys(update).length > 0) {
        await db('merchant').where({ id: merchantId }).update(update);
      }
    },
  };
}
