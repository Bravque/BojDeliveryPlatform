import { describe, expect, it } from 'vitest';
import { createBrowseService } from './service';
import type {
  BrowseCategory,
  BrowseOption,
  BrowseOptionGroup,
  BrowseProduct,
  BrowseRepo,
  MerchantDetail,
  MerchantFilters,
  MerchantListItem,
  ProductDetail,
  TownItem,
} from './repo';

class FakeBrowseRepo implements BrowseRepo {
  towns: TownItem[] = [{ name: 'Migori', timezone: 'Africa/Nairobi' }];
  merchantList: MerchantListItem[] = [];
  readonly merchants = new Map<string, MerchantDetail>();
  readonly categories = new Map<number, BrowseCategory[]>();
  readonly products = new Map<number, BrowseProduct[]>();
  readonly groups = new Map<number, BrowseOptionGroup[]>();
  readonly options = new Map<number, BrowseOption[]>();
  readonly productDetails = new Map<string, ProductDetail>();

  listActiveTowns(): Promise<TownItem[]> {
    return Promise.resolve(this.towns);
  }
  listMerchants(_filters: MerchantFilters): Promise<MerchantListItem[]> {
    return Promise.resolve(this.merchantList);
  }
  findApprovedMerchant(ulid: string): Promise<MerchantDetail | null> {
    return Promise.resolve(this.merchants.get(ulid) ?? null);
  }
  listActiveCategories(merchantId: number): Promise<BrowseCategory[]> {
    return Promise.resolve(this.categories.get(merchantId) ?? []);
  }
  listAvailableProducts(merchantId: number): Promise<BrowseProduct[]> {
    return Promise.resolve(this.products.get(merchantId) ?? []);
  }
  listOptionGroups(productIds: number[]): Promise<BrowseOptionGroup[]> {
    return Promise.resolve(productIds.flatMap((id) => this.groups.get(id) ?? []));
  }
  listAvailableOptions(groupIds: number[]): Promise<BrowseOption[]> {
    return Promise.resolve(groupIds.flatMap((id) => this.options.get(id) ?? []));
  }
  findAvailableProduct(ulid: string): Promise<ProductDetail | null> {
    return Promise.resolve(this.productDetails.get(ulid) ?? null);
  }
}

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

const MERCHANT: MerchantDetail = {
  id: 1,
  ulid: 'M1',
  name: 'Joe Kitchen',
  categoryType: 'restaurant',
  prepMinutes: 20,
  isOpen: true,
  status: 'approved',
  townName: 'Migori',
};

function seededRepo(): FakeBrowseRepo {
  const repo = new FakeBrowseRepo();
  repo.merchants.set('M1', MERCHANT);
  repo.merchantList = [
    {
      ulid: 'M1',
      name: 'Joe Kitchen',
      categoryType: 'restaurant',
      prepMinutes: 20,
      isOpen: true,
      townName: 'Migori',
    },
  ];
  repo.categories.set(1, [{ id: 10, ulid: 'C1', name: 'Mains', sortOrder: 0 }]);
  repo.products.set(1, [
    {
      id: 100,
      ulid: 'P1',
      categoryId: 10,
      name: 'Ugali',
      description: null,
      priceCents: 15000,
      currency: 'KES',
    },
    {
      id: 101,
      ulid: 'P2',
      categoryId: null,
      name: 'Water',
      description: null,
      priceCents: 5000,
      currency: 'KES',
    },
  ]);
  repo.groups.set(100, [
    { id: 1000, productId: 100, ulid: 'G1', name: 'Size', minSelect: 1, maxSelect: 1 },
  ]);
  repo.options.set(1000, [
    { optionGroupId: 1000, ulid: 'O1', name: 'Large', priceDeltaCents: 100 },
  ]);
  repo.productDetails.set('P1', {
    id: 100,
    ulid: 'P1',
    name: 'Ugali',
    description: null,
    priceCents: 15000,
    currency: 'KES',
    merchantUlid: 'M1',
  });
  return repo;
}

describe('browse service', () => {
  it('lists active towns and merchants', async () => {
    const svc = createBrowseService({ repo: seededRepo() });
    expect((await svc.listTowns())[0]?.name).toBe('Migori');
    expect((await svc.listMerchants({})).map((m) => m.ulid)).toEqual(['M1']);
  });

  it('returns an approved merchant, and 404 for an unknown one', async () => {
    const svc = createBrowseService({ repo: seededRepo() });
    expect((await svc.getMerchant('M1')).name).toBe('Joe Kitchen');
    expect(await thrownStatus(svc.getMerchant('ghost'))).toBe(404);
  });

  it('assembles the catalogue: categories → products → option groups → options, + uncategorized', async () => {
    const svc = createBrowseService({ repo: seededRepo() });
    const cat = await svc.getMerchantCatalogue('M1');

    expect(cat.merchant.ulid).toBe('M1');
    expect(cat.categories).toHaveLength(1);
    expect(cat.categories[0]?.products.map((p) => p.ulid)).toEqual(['P1']);
    expect(cat.categories[0]?.products[0]?.optionGroups[0]?.options[0]?.ulid).toBe('O1');
    expect(cat.uncategorizedProducts.map((p) => p.ulid)).toEqual(['P2']);
  });

  it('returns a product with its option groups, and 404 for an unavailable one', async () => {
    const svc = createBrowseService({ repo: seededRepo() });
    const product = await svc.getProduct('P1');
    expect(product.merchantUlid).toBe('M1');
    expect(product.optionGroups[0]?.options[0]?.ulid).toBe('O1');
    expect(await thrownStatus(svc.getProduct('P2'))).toBe(404);
  });
});
