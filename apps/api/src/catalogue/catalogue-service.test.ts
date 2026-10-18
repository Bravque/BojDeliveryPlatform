import { describe, expect, it } from 'vitest';
import { createCatalogueService } from './catalogue-service';
import type {
  CatalogueRepo,
  CategoryRecord,
  MerchantContext,
  OptionGroupRecord,
  OptionRecord,
  OwnedRef,
  ProductPatch,
  ProductRecord,
} from './repo';

class FakeCatalogueRepo implements CatalogueRepo {
  context: MerchantContext | null = { merchantId: 1, merchantUlid: 'M1' };
  readonly categories: (CategoryRecord & { merchantId: number })[] = [];
  readonly products: ProductRecord[] = [];
  readonly profileUpdates: {
    merchantId: number;
    patch: { isOpen?: boolean; prepMinutes?: number };
  }[] = [];
  readonly optionGroups: OptionGroupRecord[] = [];
  readonly options: OptionRecord[] = [];
  private cSeq = 0;
  private pSeq = 0;
  private ogSeq = 0;
  private oSeq = 0;

  findMerchantContextForUserUlid(): Promise<MerchantContext | null> {
    return Promise.resolve(this.context);
  }
  createCategory(
    merchantId: number,
    input: { ulid: string; name: string; sortOrder: number },
  ): Promise<CategoryRecord> {
    const c: CategoryRecord = {
      id: ++this.cSeq,
      ulid: input.ulid,
      name: input.name,
      sortOrder: input.sortOrder,
      isActive: true,
    };
    this.categories.push({ ...c, merchantId });
    return Promise.resolve(c);
  }
  findCategoryIdByUlidForMerchant(merchantId: number, ulid: string): Promise<number | null> {
    const c = this.categories.find((x) => x.ulid === ulid && x.merchantId === merchantId);
    return Promise.resolve(c?.id ?? null);
  }
  createProduct(
    merchantId: number,
    input: {
      ulid: string;
      categoryId: number | null;
      name: string;
      description: string | null;
      priceCents: number;
    },
  ): Promise<ProductRecord> {
    const p: ProductRecord = {
      id: ++this.pSeq,
      ulid: input.ulid,
      merchantId,
      categoryId: input.categoryId,
      name: input.name,
      description: input.description,
      priceCents: input.priceCents,
      currency: 'KES',
      isAvailable: true,
      version: 1,
    };
    this.products.push(p);
    return Promise.resolve(p);
  }
  addProduct(p: ProductRecord): void {
    this.products.push(p);
  }
  findProductByUlid(ulid: string): Promise<ProductRecord | null> {
    return Promise.resolve(this.products.find((p) => p.ulid === ulid) ?? null);
  }
  updateProductWithVersion(
    productId: number,
    expectedVersion: number,
    patch: ProductPatch,
  ): Promise<ProductRecord | null> {
    const p = this.products.find((x) => x.id === productId);
    if (!p || p.version !== expectedVersion) {
      return Promise.resolve(null);
    }
    if (patch.name !== undefined) p.name = patch.name;
    if (patch.description !== undefined) p.description = patch.description;
    if (patch.priceCents !== undefined) p.priceCents = patch.priceCents;
    if (patch.categoryId !== undefined) p.categoryId = patch.categoryId;
    p.version += 1;
    return Promise.resolve({ ...p });
  }
  setProductAvailability(productId: number, isAvailable: boolean): Promise<void> {
    const p = this.products.find((x) => x.id === productId);
    if (p) {
      p.isAvailable = isAvailable;
    }
    return Promise.resolve();
  }
  updateMerchantProfile(
    merchantId: number,
    patch: { isOpen?: boolean; prepMinutes?: number },
  ): Promise<void> {
    this.profileUpdates.push({ merchantId, patch });
    return Promise.resolve();
  }
  createOptionGroup(
    productId: number,
    input: { ulid: string; name: string; minSelect: number; maxSelect: number },
  ): Promise<OptionGroupRecord> {
    const g: OptionGroupRecord = {
      id: ++this.ogSeq,
      ulid: input.ulid,
      productId,
      name: input.name,
      minSelect: input.minSelect,
      maxSelect: input.maxSelect,
    };
    this.optionGroups.push(g);
    return Promise.resolve(g);
  }
  findOptionGroupOwnerByUlid(ulid: string): Promise<OwnedRef | null> {
    const g = this.optionGroups.find((x) => x.ulid === ulid);
    if (!g) {
      return Promise.resolve(null);
    }
    const p = this.products.find((x) => x.id === g.productId);
    return Promise.resolve(p ? { id: g.id, merchantId: p.merchantId } : null);
  }
  createOption(
    optionGroupId: number,
    input: { ulid: string; name: string; priceDeltaCents: number; isAvailable: boolean },
  ): Promise<OptionRecord> {
    const o: OptionRecord = {
      id: ++this.oSeq,
      ulid: input.ulid,
      optionGroupId,
      name: input.name,
      priceDeltaCents: input.priceDeltaCents,
      isAvailable: input.isAvailable,
    };
    this.options.push(o);
    return Promise.resolve(o);
  }
  findOptionOwnerByUlid(ulid: string): Promise<OwnedRef | null> {
    const o = this.options.find((x) => x.ulid === ulid);
    const g = o && this.optionGroups.find((x) => x.id === o.optionGroupId);
    const p = g && this.products.find((x) => x.id === g.productId);
    return Promise.resolve(o && p ? { id: o.id, merchantId: p.merchantId } : null);
  }
  setOptionAvailability(optionId: number, isAvailable: boolean): Promise<void> {
    const o = this.options.find((x) => x.id === optionId);
    if (o) {
      o.isAvailable = isAvailable;
    }
    return Promise.resolve();
  }
}

const ME = 'OWNER-ULID';

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

function setup() {
  const repo = new FakeCatalogueRepo();
  const svc = createCatalogueService({ repo });
  return { repo, svc };
}

describe('catalogue service', () => {
  it('creates a category and a product (version 1)', async () => {
    const { svc } = setup();
    const cat = await svc.createCategory(ME, { name: 'Mains', sortOrder: 0 });
    expect(cat.name).toBe('Mains');
    const prod = await svc.createProduct(ME, {
      categoryUlid: cat.ulid,
      name: 'Ugali',
      priceCents: 15000,
    });
    expect(prod.version).toBe(1);
    expect(prod.priceCents).toBe(15000);
  });

  it('rejects a product in an unknown category (400)', async () => {
    const { svc } = setup();
    expect(
      await thrownStatus(svc.createProduct(ME, { categoryUlid: 'nope', name: 'X', priceCents: 1 })),
    ).toBe(400);
  });

  it('rejects a negative/non-integer price (400)', async () => {
    const { svc } = setup();
    expect(await thrownStatus(svc.createProduct(ME, { name: 'X', priceCents: -1 }))).toBe(400);
    expect(await thrownStatus(svc.createProduct(ME, { name: 'X', priceCents: 1.5 }))).toBe(400);
  });

  it('edits a product with the right version and bumps it', async () => {
    const { svc } = setup();
    const prod = await svc.createProduct(ME, { name: 'Ugali', priceCents: 15000 });
    const edited = await svc.editProduct(ME, prod.ulid, {
      expectedVersion: 1,
      priceCents: 16000,
    });
    expect(edited.version).toBe(2);
    expect(edited.priceCents).toBe(16000);
  });

  it('returns 409 on a stale version', async () => {
    const { svc } = setup();
    const prod = await svc.createProduct(ME, { name: 'Ugali', priceCents: 15000 });
    expect(
      await thrownStatus(svc.editProduct(ME, prod.ulid, { expectedVersion: 99, priceCents: 1 })),
    ).toBe(409);
  });

  it('toggles availability', async () => {
    const { svc } = setup();
    const prod = await svc.createProduct(ME, { name: 'Ugali', priceCents: 15000 });
    const off = await svc.setAvailability(ME, prod.ulid, false);
    expect(off.isAvailable).toBe(false);
  });

  it('updates the merchant profile', async () => {
    const { repo, svc } = setup();
    const res = await svc.updateProfile(ME, { isOpen: true, prepMinutes: 25 });
    expect(res.merchantUlid).toBe('M1');
    expect(repo.profileUpdates[0]?.patch).toEqual({ isOpen: true, prepMinutes: 25 });
  });

  it('forbids a caller with no merchant (403)', async () => {
    const { repo, svc } = setup();
    repo.context = null;
    expect(await thrownStatus(svc.createCategory(ME, { name: 'X', sortOrder: 0 }))).toBe(403);
  });

  it('hides another merchant’s product (404)', async () => {
    const { repo, svc } = setup();
    repo.addProduct({
      id: 99,
      ulid: 'OTHER',
      merchantId: 2,
      categoryId: null,
      name: 'Theirs',
      description: null,
      priceCents: 100,
      currency: 'KES',
      isAvailable: true,
      version: 1,
    });
    expect(await thrownStatus(svc.editProduct(ME, 'OTHER', { expectedVersion: 1 }))).toBe(404);
  });
});

describe('catalogue service — options', () => {
  async function withProduct() {
    const { repo, svc } = setup();
    const prod = await svc.createProduct(ME, { name: 'Pizza', priceCents: 50000 });
    return { repo, svc, prod };
  }

  it('adds an option group to an owned product', async () => {
    const { svc, prod } = await withProduct();
    const group = await svc.addOptionGroup(ME, prod.ulid, {
      name: 'Size',
      minSelect: 1,
      maxSelect: 1,
    });
    expect(group.name).toBe('Size');
    expect(group.maxSelect).toBe(1);
  });

  it('rejects invalid select bounds (400)', async () => {
    const { svc, prod } = await withProduct();
    expect(
      await thrownStatus(
        svc.addOptionGroup(ME, prod.ulid, { name: 'S', minSelect: 2, maxSelect: 1 }),
      ),
    ).toBe(400);
    expect(
      await thrownStatus(
        svc.addOptionGroup(ME, prod.ulid, { name: 'S', minSelect: 0, maxSelect: 0 }),
      ),
    ).toBe(400);
  });

  it('adds an option (default available) and rejects a negative delta (400)', async () => {
    const { svc, prod } = await withProduct();
    const group = await svc.addOptionGroup(ME, prod.ulid, {
      name: 'Size',
      minSelect: 1,
      maxSelect: 1,
    });
    const opt = await svc.addOption(ME, group.ulid, { name: 'Large', priceDeltaCents: 10000 });
    expect(opt.isAvailable).toBe(true);
    expect(opt.priceDeltaCents).toBe(10000);
    expect(
      await thrownStatus(svc.addOption(ME, group.ulid, { name: 'Free', priceDeltaCents: -1 })),
    ).toBe(400);
  });

  it('toggles option availability', async () => {
    const { svc, prod } = await withProduct();
    const group = await svc.addOptionGroup(ME, prod.ulid, {
      name: 'Size',
      minSelect: 1,
      maxSelect: 1,
    });
    const opt = await svc.addOption(ME, group.ulid, { name: 'Large', priceDeltaCents: 10000 });
    const off = await svc.setOptionAvailability(ME, opt.ulid, false);
    expect(off.isAvailable).toBe(false);
  });

  it('hides another merchant’s group / option (404)', async () => {
    const { repo, svc } = setup();
    repo.addProduct({
      id: 50,
      ulid: 'P2',
      merchantId: 2,
      categoryId: null,
      name: 'Theirs',
      description: null,
      priceCents: 1,
      currency: 'KES',
      isAvailable: true,
      version: 1,
    });
    repo.optionGroups.push({
      id: 50,
      ulid: 'G2',
      productId: 50,
      name: 'Size',
      minSelect: 0,
      maxSelect: 1,
    });
    repo.options.push({
      id: 50,
      ulid: 'O2',
      optionGroupId: 50,
      name: 'Large',
      priceDeltaCents: 0,
      isAvailable: true,
    });
    expect(await thrownStatus(svc.addOption(ME, 'G2', { name: 'X', priceDeltaCents: 0 }))).toBe(
      404,
    );
    expect(await thrownStatus(svc.setOptionAvailability(ME, 'O2', false))).toBe(404);
  });

  it('forbids a caller with no merchant (403)', async () => {
    const { repo, svc, prod } = await withProduct();
    repo.context = null;
    expect(
      await thrownStatus(
        svc.addOptionGroup(ME, prod.ulid, { name: 'S', minSelect: 0, maxSelect: 1 }),
      ),
    ).toBe(403);
  });
});
