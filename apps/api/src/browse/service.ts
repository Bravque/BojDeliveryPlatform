import { notFound } from '../http/errors';
import type {
  BrowseProduct,
  BrowseRepo,
  MerchantFilters,
  MerchantListItem,
  TownItem,
} from './repo';

export interface PublicMerchant {
  ulid: string;
  name: string;
  categoryType: string;
  prepMinutes: number;
  isOpen: boolean;
  townName: string;
}

export interface PublicOption {
  ulid: string;
  name: string;
  priceDeltaCents: number;
}

export interface PublicOptionGroup {
  ulid: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: PublicOption[];
}

export interface PublicProduct {
  ulid: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  optionGroups: PublicOptionGroup[];
}

export interface PublicCategory {
  ulid: string;
  name: string;
  sortOrder: number;
  products: PublicProduct[];
}

export interface PublicCatalogue {
  merchant: PublicMerchant;
  categories: PublicCategory[];
  uncategorizedProducts: PublicProduct[];
}

export interface BrowseServiceDeps {
  repo: BrowseRepo;
}

export function createBrowseService(deps: BrowseServiceDeps) {
  const { repo } = deps;

  function listTowns(): Promise<TownItem[]> {
    return repo.listActiveTowns();
  }

  function listMerchants(filters: MerchantFilters): Promise<MerchantListItem[]> {
    return repo.listMerchants(filters);
  }

  async function getMerchant(ulid: string): Promise<PublicMerchant> {
    const m = await repo.findApprovedMerchant(ulid);
    if (!m) {
      throw notFound('Merchant not found');
    }
    return {
      ulid: m.ulid,
      name: m.name,
      categoryType: m.categoryType,
      prepMinutes: m.prepMinutes,
      isOpen: m.isOpen,
      townName: m.townName,
    };
  }

  /** Build `PublicOptionGroup[]` keyed by product id for the given products. */
  async function optionGroupsByProduct(
    products: BrowseProduct[],
  ): Promise<Map<number, PublicOptionGroup[]>> {
    const groups = await repo.listOptionGroups(products.map((p) => p.id));
    const options = await repo.listAvailableOptions(groups.map((g) => g.id));

    const optionsByGroup = new Map<number, PublicOption[]>();
    for (const o of options) {
      const list = optionsByGroup.get(o.optionGroupId) ?? [];
      list.push({ ulid: o.ulid, name: o.name, priceDeltaCents: o.priceDeltaCents });
      optionsByGroup.set(o.optionGroupId, list);
    }

    const byProduct = new Map<number, PublicOptionGroup[]>();
    for (const g of groups) {
      const list = byProduct.get(g.productId) ?? [];
      list.push({
        ulid: g.ulid,
        name: g.name,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        options: optionsByGroup.get(g.id) ?? [],
      });
      byProduct.set(g.productId, list);
    }
    return byProduct;
  }

  function toPublicProduct(
    p: BrowseProduct,
    groups: Map<number, PublicOptionGroup[]>,
  ): PublicProduct {
    return {
      ulid: p.ulid,
      name: p.name,
      description: p.description,
      priceCents: p.priceCents,
      currency: p.currency,
      optionGroups: groups.get(p.id) ?? [],
    };
  }

  async function getMerchantCatalogue(ulid: string): Promise<PublicCatalogue> {
    const m = await repo.findApprovedMerchant(ulid);
    if (!m) {
      throw notFound('Merchant not found');
    }
    const [categories, products] = await Promise.all([
      repo.listActiveCategories(m.id),
      repo.listAvailableProducts(m.id),
    ]);
    const groupsByProduct = await optionGroupsByProduct(products);

    const productsByCategory = new Map<number, PublicProduct[]>();
    const uncategorized: PublicProduct[] = [];
    for (const p of products) {
      const pub = toPublicProduct(p, groupsByProduct);
      if (p.categoryId === null) {
        uncategorized.push(pub);
      } else {
        const list = productsByCategory.get(p.categoryId) ?? [];
        list.push(pub);
        productsByCategory.set(p.categoryId, list);
      }
    }

    return {
      merchant: {
        ulid: m.ulid,
        name: m.name,
        categoryType: m.categoryType,
        prepMinutes: m.prepMinutes,
        isOpen: m.isOpen,
        townName: m.townName,
      },
      categories: categories.map((c) => ({
        ulid: c.ulid,
        name: c.name,
        sortOrder: c.sortOrder,
        products: productsByCategory.get(c.id) ?? [],
      })),
      uncategorizedProducts: uncategorized,
    };
  }

  async function getProduct(ulid: string): Promise<PublicProduct & { merchantUlid: string }> {
    const p = await repo.findAvailableProduct(ulid);
    if (!p) {
      throw notFound('Product not found');
    }
    const groups = await optionGroupsByProduct([{ ...p, categoryId: null } as BrowseProduct]);
    return {
      ulid: p.ulid,
      name: p.name,
      description: p.description,
      priceCents: p.priceCents,
      currency: p.currency,
      optionGroups: groups.get(p.id) ?? [],
      merchantUlid: p.merchantUlid,
    };
  }

  return { listTowns, listMerchants, getMerchant, getMerchantCatalogue, getProduct };
}

export type BrowseService = ReturnType<typeof createBrowseService>;
