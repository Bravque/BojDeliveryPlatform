import { newUlid } from '../auth/crypto';
import { badRequest, conflict, notFound, unauthorized } from '../http/errors';
import type { CartRepo, OptionConfig, ProductForCart } from './repo';

/** The acting principal (from req.principal). A cart always belongs to this user. */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface AddItemInput {
  productUlid: string;
  quantity: number;
  optionUlids?: string[];
}

export interface CartItemView {
  ulid: string;
  product: {
    ulid: string;
    name: string;
    priceCents: number;
    currency: string;
    isAvailable: boolean;
  };
  quantity: number;
  options: Array<{ ulid: string; name: string; priceDeltaCents: number }>;
}

export interface CartView {
  merchant: { ulid: string; name: string } | null;
  items: CartItemView[];
}

export interface CartServiceDeps {
  repo: CartRepo;
}

const MAX_QUANTITY = 99;

/** Both arrays are stored sorted, so a positional compare is enough. */
function sameOptionSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((ulid, i) => ulid === b[i]);
}

export function createCartService(deps: CartServiceDeps) {
  const { repo } = deps;

  async function requireUserId(actor: Actor): Promise<number> {
    const userId = await repo.findUserIdByUlid(actor.ulid);
    if (userId === null) {
      throw unauthorized('Unknown principal');
    }
    return userId;
  }

  /** Validate a product's selected options: known, available, and within each group's min/max. */
  async function validateOptions(product: ProductForCart, optionUlids: string[]): Promise<void> {
    if (new Set(optionUlids).size !== optionUlids.length) {
      throw badRequest('Duplicate option selected', [{ field: 'optionUlids', issue: 'duplicate' }]);
    }
    const groups = await repo.getOptionGroups(product.id);
    const options = await repo.getOptions(product.id);
    const byUlid = new Map<string, OptionConfig>(options.map((o) => [o.ulid, o]));

    const countByGroup = new Map<number, number>();
    for (const ulid of optionUlids) {
      const option = byUlid.get(ulid);
      if (!option) {
        throw notFound('Option not found for this product');
      }
      if (!option.isAvailable) {
        throw badRequest('Option is not available', [{ field: 'optionUlids', issue: ulid }]);
      }
      countByGroup.set(option.optionGroupId, (countByGroup.get(option.optionGroupId) ?? 0) + 1);
    }

    for (const group of groups) {
      const count = countByGroup.get(group.id) ?? 0;
      if (count < group.minSelect || count > group.maxSelect) {
        throw badRequest('Option selection out of bounds', [
          {
            field: 'optionUlids',
            issue: `group requires between ${group.minSelect} and ${group.maxSelect} selections`,
          },
        ]);
      }
    }
  }

  async function assembleCart(userId: number): Promise<CartView> {
    const cart = await repo.findCartByUserId(userId);
    if (!cart) {
      return { merchant: null, items: [] };
    }
    const items = await repo.listItems(cart.id);
    const merchant = cart.merchantId !== null ? await repo.findMerchantById(cart.merchantId) : null;
    if (items.length === 0) {
      return { merchant, items: [] };
    }

    const products = new Map(
      (await repo.getProductsByIds([...new Set(items.map((i) => i.productId))])).map((p) => [
        p.id,
        p,
      ]),
    );
    const optionUlids = [...new Set(items.flatMap((i) => i.optionUlids))];
    const optionsByUlid = new Map(
      (await repo.getOptionsByUlids(optionUlids)).map((o) => [o.ulid, o]),
    );

    const views = items.flatMap<CartItemView>((item) => {
      const product = products.get(item.productId);
      if (!product) {
        return []; // product removal is blocked by FK; defensive only
      }
      const options = item.optionUlids.flatMap((ulid) => {
        const option = optionsByUlid.get(ulid);
        return option ? [option] : [];
      });
      return [
        {
          ulid: item.ulid,
          product: {
            ulid: product.ulid,
            name: product.name,
            priceCents: product.priceCents,
            currency: product.currency,
            isAvailable: product.isAvailable,
          },
          quantity: item.quantity,
          options,
        },
      ];
    });

    return { merchant, items: views };
  }

  async function getCart(actor: Actor): Promise<CartView> {
    return assembleCart(await requireUserId(actor));
  }

  async function addItem(actor: Actor, input: AddItemInput): Promise<CartView> {
    const userId = await requireUserId(actor);
    const product = await repo.findProductForCart(input.productUlid);
    if (!product || !product.isAvailable || product.merchantStatus !== 'approved') {
      throw notFound('Product not available');
    }

    const cart = (await repo.findCartByUserId(userId)) ?? (await repo.createCart(userId));
    if (cart.merchantId !== null && cart.merchantId !== product.merchantId) {
      throw conflict(
        'CART_MERCHANT_MISMATCH',
        'Cart already contains items from another merchant; clear it first',
      );
    }

    const optionUlids = [...(input.optionUlids ?? [])].sort();
    await validateOptions(product, optionUlids);

    const items = await repo.listItems(cart.id);
    const existing = items.find(
      (i) => i.productId === product.id && sameOptionSet(i.optionUlids, optionUlids),
    );
    if (existing) {
      await repo.updateItemQuantity(
        existing.id,
        Math.min(existing.quantity + input.quantity, MAX_QUANTITY),
      );
    } else {
      await repo.addItem({
        ulid: newUlid(),
        cartId: cart.id,
        productId: product.id,
        quantity: input.quantity,
        optionUlids,
      });
    }

    if (cart.merchantId === null) {
      await repo.setCartMerchant(cart.id, product.merchantId);
    }
    return assembleCart(userId);
  }

  /** Load a cart item and assert it belongs to the actor's cart; 404 otherwise. */
  async function ownedItem(userId: number, itemUlid: string) {
    const cart = await repo.findCartByUserId(userId);
    const item = cart ? await repo.findItemByUlid(itemUlid) : null;
    if (!cart || !item || item.cartId !== cart.id) {
      throw notFound('Cart item not found');
    }
    return { cart, item };
  }

  async function updateQuantity(
    actor: Actor,
    itemUlid: string,
    quantity: number,
  ): Promise<CartView> {
    const userId = await requireUserId(actor);
    const { item } = await ownedItem(userId, itemUlid);
    await repo.updateItemQuantity(item.id, quantity);
    return assembleCart(userId);
  }

  async function removeItem(actor: Actor, itemUlid: string): Promise<CartView> {
    const userId = await requireUserId(actor);
    const { cart, item } = await ownedItem(userId, itemUlid);
    await repo.deleteItem(item.id);
    const remaining = await repo.listItems(cart.id);
    if (remaining.length === 0) {
      await repo.setCartMerchant(cart.id, null);
    }
    return assembleCart(userId);
  }

  async function clearCart(actor: Actor): Promise<CartView> {
    const userId = await requireUserId(actor);
    const cart = await repo.findCartByUserId(userId);
    if (cart) {
      await repo.deleteItemsByCart(cart.id);
      await repo.setCartMerchant(cart.id, null);
    }
    return assembleCart(userId);
  }

  return { getCart, addItem, updateQuantity, removeItem, clearCart };
}

export type CartService = ReturnType<typeof createCartService>;
