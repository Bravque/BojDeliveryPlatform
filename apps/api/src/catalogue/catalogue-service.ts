import { newUlid } from '../auth/crypto';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import type {
  CatalogueRepo,
  MerchantContext,
  OptionGroupRecord,
  OptionRecord,
  ProductPatch,
  ProductRecord,
} from './repo';

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

export interface OptionGroupSummary {
  ulid: string;
  name: string;
  minSelect: number;
  maxSelect: number;
}

export interface OptionSummary {
  ulid: string;
  name: string;
  priceDeltaCents: number;
  isAvailable: boolean;
}

function toOptionGroupSummary(g: OptionGroupRecord): OptionGroupSummary {
  return { ulid: g.ulid, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect };
}

function toOptionSummary(o: OptionRecord): OptionSummary {
  return {
    ulid: o.ulid,
    name: o.name,
    priceDeltaCents: o.priceDeltaCents,
    isAvailable: o.isAvailable,
  };
}

function assertSelectBounds(minSelect: number, maxSelect: number): void {
  if (
    !Number.isInteger(minSelect) ||
    !Number.isInteger(maxSelect) ||
    minSelect < 0 ||
    maxSelect < 1 ||
    minSelect > maxSelect
  ) {
    throw badRequest(
      'Invalid select bounds: require 0 <= minSelect <= maxSelect and maxSelect >= 1',
      [
        { field: 'minSelect', issue: 'invalid' },
        { field: 'maxSelect', issue: 'invalid' },
      ],
    );
  }
}

function assertPriceDelta(priceDeltaCents: number): void {
  if (!Number.isInteger(priceDeltaCents) || priceDeltaCents < 0) {
    throw badRequest('Option price delta must be a non-negative integer number of cents', [
      { field: 'priceDeltaCents', issue: 'invalid' },
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

  async function addOptionGroup(
    actorUlid: string,
    productUlid: string,
    input: { name: string; minSelect: number; maxSelect: number },
  ): Promise<OptionGroupSummary> {
    const ctx = await requireContext(actorUlid);
    const product = await ownedProduct(ctx, productUlid);
    assertSelectBounds(input.minSelect, input.maxSelect);
    const group = await repo.createOptionGroup(product.id, {
      ulid: newUlid(),
      name: input.name,
      minSelect: input.minSelect,
      maxSelect: input.maxSelect,
    });
    return toOptionGroupSummary(group);
  }

  async function addOption(
    actorUlid: string,
    groupUlid: string,
    input: { name: string; priceDeltaCents: number; isAvailable?: boolean },
  ): Promise<OptionSummary> {
    const ctx = await requireContext(actorUlid);
    const group = await repo.findOptionGroupOwnerByUlid(groupUlid);
    if (!group || group.merchantId !== ctx.merchantId) {
      throw notFound('Option group not found');
    }
    assertPriceDelta(input.priceDeltaCents);
    const option = await repo.createOption(group.id, {
      ulid: newUlid(),
      name: input.name,
      priceDeltaCents: input.priceDeltaCents,
      isAvailable: input.isAvailable ?? true,
    });
    return toOptionSummary(option);
  }

  async function setOptionAvailability(
    actorUlid: string,
    optionUlid: string,
    isAvailable: boolean,
  ): Promise<{ ulid: string; isAvailable: boolean }> {
    const ctx = await requireContext(actorUlid);
    const option = await repo.findOptionOwnerByUlid(optionUlid);
    if (!option || option.merchantId !== ctx.merchantId) {
      throw notFound('Option not found');
    }
    await repo.setOptionAvailability(option.id, isAvailable);
    return { ulid: optionUlid, isAvailable };
  }

  return {
    createCategory,
    createProduct,
    editProduct,
    setAvailability,
    updateProfile,
    addOptionGroup,
    addOption,
    setOptionAvailability,
  };
}

export type CatalogueService = ReturnType<typeof createCatalogueService>;
