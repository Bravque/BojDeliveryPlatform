import { describe, expect, it } from 'vitest';
import { createCartService, type Actor } from './cart-service';
import type {
  CartItemRecord,
  CartRecord,
  CartRepo,
  CreateCartItemInput,
  MerchantBrief,
  OptionConfig,
  OptionGroupConfig,
  ProductBrief,
  ProductForCart,
} from './repo';

class FakeCartRepo implements CartRepo {
  users = new Map<string, number>([
    ['cust', 7],
    ['other', 8],
  ]);
  merchants = new Map<number, MerchantBrief>([
    [1, { ulid: 'M1', name: 'Joe Kitchen' }],
    [2, { ulid: 'M2', name: 'Mama Ntilie' }],
  ]);
  products = new Map<string, ProductForCart>();
  groupsByProduct = new Map<number, OptionGroupConfig[]>();
  optionsByProduct = new Map<number, OptionConfig[]>();
  carts: CartRecord[] = [];
  items: CartItemRecord[] = [];
  private cartSeq = 0;
  private itemSeq = 0;

  findUserIdByUlid(ulid: string): Promise<number | null> {
    return Promise.resolve(this.users.get(ulid) ?? null);
  }
  findCartByUserId(userId: number): Promise<CartRecord | null> {
    return Promise.resolve(this.carts.find((c) => c.userId === userId) ?? null);
  }
  createCart(userId: number): Promise<CartRecord> {
    const cart: CartRecord = { id: ++this.cartSeq, userId, merchantId: null };
    this.carts.push(cart);
    return Promise.resolve(cart);
  }
  setCartMerchant(cartId: number, merchantId: number | null): Promise<void> {
    const c = this.carts.find((cart) => cart.id === cartId);
    if (c) c.merchantId = merchantId;
    return Promise.resolve();
  }
  findMerchantById(merchantId: number): Promise<MerchantBrief | null> {
    return Promise.resolve(this.merchants.get(merchantId) ?? null);
  }
  findProductForCart(productUlid: string): Promise<ProductForCart | null> {
    return Promise.resolve(this.products.get(productUlid) ?? null);
  }
  getOptionGroups(productId: number): Promise<OptionGroupConfig[]> {
    return Promise.resolve(this.groupsByProduct.get(productId) ?? []);
  }
  getOptions(productId: number): Promise<OptionConfig[]> {
    return Promise.resolve(this.optionsByProduct.get(productId) ?? []);
  }
  listItems(cartId: number): Promise<CartItemRecord[]> {
    return Promise.resolve(this.items.filter((i) => i.cartId === cartId));
  }
  addItem(input: CreateCartItemInput): Promise<CartItemRecord> {
    const item: CartItemRecord = { id: ++this.itemSeq, ...input };
    this.items.push(item);
    return Promise.resolve(item);
  }
  findItemByUlid(ulid: string): Promise<CartItemRecord | null> {
    return Promise.resolve(this.items.find((i) => i.ulid === ulid) ?? null);
  }
  updateItemQuantity(itemId: number, quantity: number): Promise<void> {
    const i = this.items.find((item) => item.id === itemId);
    if (i) i.quantity = quantity;
    return Promise.resolve();
  }
  deleteItem(itemId: number): Promise<void> {
    this.items = this.items.filter((i) => i.id !== itemId);
    return Promise.resolve();
  }
  deleteItemsByCart(cartId: number): Promise<void> {
    this.items = this.items.filter((i) => i.cartId !== cartId);
    return Promise.resolve();
  }
  getProductsByIds(ids: number[]): Promise<ProductBrief[]> {
    const all = [...this.products.values()].filter((p) => ids.includes(p.id));
    return Promise.resolve(
      all.map((p) => ({
        id: p.id,
        ulid: p.ulid,
        name: p.name,
        priceCents: p.priceCents,
        currency: p.currency,
        isAvailable: p.isAvailable,
      })),
    );
  }
  getOptionsByUlids(
    ulids: string[],
  ): Promise<Array<{ ulid: string; name: string; priceDeltaCents: number }>> {
    const all = [...this.optionsByProduct.values()].flat().filter((o) => ulids.includes(o.ulid));
    return Promise.resolve(
      all.map((o) => ({ ulid: o.ulid, name: o.name, priceDeltaCents: o.priceDeltaCents })),
    );
  }
}

function product(
  over: Partial<ProductForCart> & Pick<ProductForCart, 'id' | 'ulid'>,
): ProductForCart {
  return {
    merchantId: 1,
    merchantUlid: 'M1',
    merchantName: 'Joe Kitchen',
    merchantStatus: 'approved',
    name: 'Item',
    priceCents: 10_000,
    currency: 'KES',
    isAvailable: true,
    ...over,
  };
}

function seededRepo(): FakeCartRepo {
  const repo = new FakeCartRepo();
  repo.products.set('P1', product({ id: 100, ulid: 'P1', name: 'Ugali', priceCents: 15_000 }));
  repo.products.set('P2', product({ id: 101, ulid: 'P2', name: 'Water', priceCents: 5_000 }));
  repo.products.set('PX', product({ id: 102, ulid: 'PX', name: 'Gone', isAvailable: false }));
  repo.products.set(
    'Q1',
    product({ id: 200, ulid: 'Q1', merchantId: 2, merchantUlid: 'M2', name: 'Rice' }),
  );
  repo.groupsByProduct.set(100, [{ id: 1000, minSelect: 1, maxSelect: 1 }]);
  repo.optionsByProduct.set(100, [
    {
      id: 1,
      ulid: 'O1',
      optionGroupId: 1000,
      name: 'Large',
      priceDeltaCents: 100,
      isAvailable: true,
    },
    {
      id: 2,
      ulid: 'O2',
      optionGroupId: 1000,
      name: 'Small',
      priceDeltaCents: 0,
      isAvailable: true,
    },
    {
      id: 3,
      ulid: 'OX',
      optionGroupId: 1000,
      name: 'Gone',
      priceDeltaCents: 0,
      isAvailable: false,
    },
  ]);
  return repo;
}

const CUST: Actor = { ulid: 'cust', roles: ['customer'] };
const OTHER: Actor = { ulid: 'other', roles: ['customer'] };

function svcWith(repo = seededRepo()) {
  return { repo, svc: createCartService({ repo }) };
}

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

describe('cart service — adding items', () => {
  it('adds the first item, setting the cart merchant, and enriches the view', async () => {
    const { svc } = svcWith();
    const cart = await svc.addItem(CUST, { productUlid: 'P1', quantity: 2, optionUlids: ['O1'] });
    expect(cart.merchant).toEqual({ ulid: 'M1', name: 'Joe Kitchen' });
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]?.product.name).toBe('Ugali');
    expect(cart.items[0]?.quantity).toBe(2);
    expect(cart.items[0]?.options.map((o) => o.name)).toEqual(['Large']);
  });

  it('merges an identical line by summing quantity', async () => {
    const { svc } = svcWith();
    await svc.addItem(CUST, { productUlid: 'P1', quantity: 2, optionUlids: ['O1'] });
    const cart = await svc.addItem(CUST, { productUlid: 'P1', quantity: 1, optionUlids: ['O1'] });
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]?.quantity).toBe(3);
  });

  it('keeps different option selections as separate lines', async () => {
    const { svc } = svcWith();
    await svc.addItem(CUST, { productUlid: 'P1', quantity: 1, optionUlids: ['O1'] });
    const cart = await svc.addItem(CUST, { productUlid: 'P1', quantity: 1, optionUlids: ['O2'] });
    expect(cart.items).toHaveLength(2);
  });

  it('rejects a second merchant with 409', async () => {
    const { svc } = svcWith();
    await svc.addItem(CUST, { productUlid: 'P1', quantity: 1, optionUlids: ['O1'] });
    expect(await thrownStatus(svc.addItem(CUST, { productUlid: 'Q1', quantity: 1 }))).toBe(409);
  });

  it('404s an unavailable product', async () => {
    const { svc } = svcWith();
    expect(await thrownStatus(svc.addItem(CUST, { productUlid: 'PX', quantity: 1 }))).toBe(404);
  });

  it('401s an unknown principal', async () => {
    const { svc } = svcWith();
    const ghost: Actor = { ulid: 'ghost', roles: ['customer'] };
    expect(
      await thrownStatus(
        svc.addItem(ghost, { productUlid: 'P1', quantity: 1, optionUlids: ['O1'] }),
      ),
    ).toBe(401);
  });
});

describe('cart service — option validation', () => {
  it('requires a selection for a min=1 group (400)', async () => {
    const { svc } = svcWith();
    expect(await thrownStatus(svc.addItem(CUST, { productUlid: 'P1', quantity: 1 }))).toBe(400);
  });

  it('rejects exceeding max-select (400)', async () => {
    const { svc } = svcWith();
    expect(
      await thrownStatus(
        svc.addItem(CUST, { productUlid: 'P1', quantity: 1, optionUlids: ['O1', 'O2'] }),
      ),
    ).toBe(400);
  });

  it('rejects an unavailable option (400) and an unknown option (404)', async () => {
    const { svc } = svcWith();
    expect(
      await thrownStatus(
        svc.addItem(CUST, { productUlid: 'P1', quantity: 1, optionUlids: ['OX'] }),
      ),
    ).toBe(400);
    expect(
      await thrownStatus(
        svc.addItem(CUST, { productUlid: 'P1', quantity: 1, optionUlids: ['ZZ'] }),
      ),
    ).toBe(404);
  });

  it('rejects duplicate options (400)', async () => {
    const { svc } = svcWith();
    expect(
      await thrownStatus(
        svc.addItem(CUST, { productUlid: 'P1', quantity: 1, optionUlids: ['O1', 'O1'] }),
      ),
    ).toBe(400);
  });

  it('accepts a product with no option groups', async () => {
    const { svc } = svcWith();
    const cart = await svc.addItem(CUST, { productUlid: 'P2', quantity: 1 });
    expect(cart.items[0]?.product.name).toBe('Water');
    expect(cart.items[0]?.options).toEqual([]);
  });
});

describe('cart service — mutating and clearing', () => {
  it('updates quantity, and 404s another user', async () => {
    const { svc } = svcWith();
    const added = await svc.addItem(CUST, { productUlid: 'P2', quantity: 1 });
    const itemUlid = added.items[0]!.ulid;
    const updated = await svc.updateQuantity(CUST, itemUlid, 5);
    expect(updated.items[0]?.quantity).toBe(5);
    expect(await thrownStatus(svc.updateQuantity(OTHER, itemUlid, 2))).toBe(404);
  });

  it('clears the merchant when the last item is removed', async () => {
    const { svc } = svcWith();
    const added = await svc.addItem(CUST, { productUlid: 'P2', quantity: 1 });
    const cart = await svc.removeItem(CUST, added.items[0]!.ulid);
    expect(cart.items).toEqual([]);
    expect(cart.merchant).toBeNull();
  });

  it('clears the whole cart', async () => {
    const { svc } = svcWith();
    await svc.addItem(CUST, { productUlid: 'P1', quantity: 1, optionUlids: ['O1'] });
    await svc.addItem(CUST, { productUlid: 'P2', quantity: 1 });
    const cart = await svc.clearCart(CUST);
    expect(cart.items).toEqual([]);
    expect(cart.merchant).toBeNull();
  });

  it('returns an empty cart for a user with none', async () => {
    const { svc } = svcWith();
    expect(await svc.getCart(CUST)).toEqual({ merchant: null, items: [] });
  });
});
