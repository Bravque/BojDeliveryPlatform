import { newUlid } from '../auth/crypto';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import type { CatalogueRepo, MerchantContext, ProductPatch, ProductRecord } from './repo';

export interface CategorySummary {
  ulid: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface ProductSummary {
  ulid: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  isAvailable: boolean;
  version: number;
}

export interface CatalogueServiceDeps {
  repo: CatalogueRepo;
}

function toProductSummary(p: ProductRecord): ProductSummary {
  return {
    ulid: p.ulid,
    name: p.name,
    description: p.description,
    priceCents: p.priceCents,
    currency: p.currency,
    isAvailable: p.isAvailable,
    version: p.version,
  };
}

function assertPrice(priceCents: number): void {
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw badRequest('Price must be a non-negative integer number of cents', [
      { field: 'priceCents', issue: 'invalid' },
    ]);
  }
}

/**
 * Merchant-facing catalogue management. Ownership is enforced server-side: every operation
 * resolves the caller's merchant (via merchant_user) and only touches that merchant's resources.
 * Product edits are optimistically locked on `version`.
 */
export function createCatalogueService(deps: CatalogueServiceDeps) {
  const { repo } = deps;

  async function requireContext(actorUlid: string): Promise<MerchantContext> {
    const ctx = await repo.findMerchantContextForUserUlid(actorUlid);
    if (!ctx) {
      throw forbidden('Not a member of any merchant');
    }
    return ctx;
  }

  async function resolveCategory(
    ctx: MerchantContext,
    categoryUlid?: string,
  ): Promise<number | null> {
    if (!categoryUlid) {
      return null;
    }
    const id = await repo.findCategoryIdByUlidForMerchant(ctx.merchantId, categoryUlid);
    if (id === null) {
      throw badRequest('Unknown category', [
        { field: 'categoryUlid', issue: 'not found for this merchant' },
      ]);
    }
    return id;
  }

  async function ownedProduct(ctx: MerchantContext, productUlid: string): Promise<ProductRecord> {
    const product = await repo.findProductByUlid(productUlid);
    if (!product || product.merchantId !== ctx.merchantId) {
      throw notFound('Product not found');
    }
    return product;
  }

  async function createCategory(
    actorUlid: string,
    input: { name: string; sortOrder: number },
  ): Promise<CategorySummary> {
    const ctx = await requireContext(actorUlid);
    const c = await repo.createCategory(ctx.merchantId, {
      ulid: newUlid(),
      name: input.name,
      sortOrder: input.sortOrder,
    });
    return { ulid: c.ulid, name: c.name, sortOrder: c.sortOrder, isActive: c.isActive };
  }

  async function createProduct(
    actorUlid: string,
    input: { categoryUlid?: string; name: string; description?: string; priceCents: number },
  ): Promise<ProductSummary> {
    const ctx = await requireContext(actorUlid);
    assertPrice(input.priceCents);
    const categoryId = await resolveCategory(ctx, input.categoryUlid);
    const p = await repo.createProduct(ctx.merchantId, {
      ulid: newUlid(),
      categoryId,
      name: input.name,
      description: input.description ?? null,
      priceCents: input.priceCents,
    });
    return toProductSummary(p);
  }

  async function editProduct(
    actorUlid: string,
    productUlid: string,
    input: {
      expectedVersion: number;
      name?: string;
      description?: string | null;
      priceCents?: number;
      categoryUlid?: string;
    },
  ): Promise<ProductSummary> {
    const ctx = await requireContext(actorUlid);
    const product = await ownedProduct(ctx, productUlid);
    if (input.priceCents !== undefined) {
      assertPrice(input.priceCents);
    }
    const patch: ProductPatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.priceCents !== undefined) patch.priceCents = input.priceCents;
    if (input.categoryUlid !== undefined)
      patch.categoryId = await resolveCategory(ctx, input.categoryUlid);

    const updated = await repo.updateProductWithVersion(product.id, input.expectedVersion, patch);
    if (!updated) {
      throw conflict('VERSION_CONFLICT', 'Product was modified by someone else; reload and retry');
    }
    return toProductSummary(updated);
  }

  async function setAvailability(
    actorUlid: string,
    productUlid: string,
    isAvailable: boolean,
  ): Promise<ProductSummary> {
    const ctx = await requireContext(actorUlid);
    const product = await ownedProduct(ctx, productUlid);
    await repo.setProductAvailability(product.id, isAvailable);
    return toProductSummary({ ...product, isAvailable });
  }

  async function updateProfile(
    actorUlid: string,
    patch: { isOpen?: boolean; prepMinutes?: number },
  ): Promise<{ merchantUlid: string }> {
    const ctx = await requireContext(actorUlid);
    await repo.updateMerchantProfile(ctx.merchantId, patch);
    return { merchantUlid: ctx.merchantUlid };
  }

  return { createCategory, createProduct, editProduct, setAvailability, updateProfile };
}

export type CatalogueService = ReturnType<typeof createCatalogueService>;
