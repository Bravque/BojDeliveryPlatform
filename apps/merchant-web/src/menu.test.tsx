import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MenuView } from './menu';
import {
  ApiError,
  type ApiClient,
  type ManagedProduct,
  type MerchantCatalogue,
  type ProductSummary,
} from './api';

const mkProduct = (over: Partial<ManagedProduct>): ManagedProduct => ({
  ulid: 'P1',
  name: 'Pizza',
  description: null,
  priceCents: 50_000,
  currency: 'KES',
  isAvailable: true,
  version: 1,
  categoryUlid: 'C1',
  inventory: null,
  optionGroups: [],
  ...over,
});

const toSummary = (p: ManagedProduct): ProductSummary => ({
  ulid: p.ulid,
  name: p.name,
  description: p.description,
  priceCents: p.priceCents,
  currency: p.currency,
  isAvailable: p.isAvailable,
  version: p.version,
});

const rejects = () => vi.fn(() => Promise.reject(new Error('not used')));

/** A catalogue-focused mock whose in-memory catalogue mutates as the merchant edits. */
function makeApi() {
  let catalogue: MerchantCatalogue = {
    merchant: { ulid: 'M1' },
    categories: [{ ulid: 'C1', name: 'Mains', sortOrder: 0, isActive: true }],
    products: [mkProduct({})],
  };
  let seq = 1;
  const put = (p: ManagedProduct) => {
    catalogue = {
      ...catalogue,
      products: catalogue.products.map((x) => (x.ulid === p.ulid ? p : x)),
    };
  };
  const api: ApiClient = {
    login: rejects(),
    listMerchantOrders: rejects(),
    getMerchantOrder: rejects(),
    acceptOrder: rejects(),
    startPreparing: rejects(),
    markReady: rejects(),
    rejectOrder: rejects(),
    getCatalogue: vi.fn(() => Promise.resolve(structuredClone(catalogue))),
    createCategory: vi.fn((_t, input) => {
      const c = { ulid: `C${seq++}`, name: input.name, sortOrder: 0, isActive: true };
      catalogue = { ...catalogue, categories: [...catalogue.categories, c] };
      return Promise.resolve(c);
    }),
    createProduct: vi.fn((_t, input) => {
      const p = mkProduct({
        ulid: `P${seq++}`,
        name: input.name,
        priceCents: input.priceCents,
        categoryUlid: input.categoryUlid ?? null,
        description: input.description ?? null,
      });
      catalogue = { ...catalogue, products: [...catalogue.products, p] };
      return Promise.resolve(toSummary(p));
    }),
    editProduct: vi.fn((_t, ulid, input) => {
      const p = catalogue.products.find((x) => x.ulid === ulid)!;
      if (p.version !== input.expectedVersion) {
        return Promise.reject(new ApiError(409, 'VERSION_CONFLICT', 'stale'));
      }
      const np = mkProduct({
        ...p,
        name: input.name ?? p.name,
        priceCents: input.priceCents ?? p.priceCents,
        version: p.version + 1,
      });
      put(np);
      return Promise.resolve(toSummary(np));
    }),
    setProductAvailability: vi.fn((_t, ulid, isAvailable) => {
      const p = catalogue.products.find((x) => x.ulid === ulid)!;
      const np = mkProduct({ ...p, isAvailable });
      put(np);
      return Promise.resolve(toSummary(np));
    }),
    setInventory: vi.fn((_t, _u, input) =>
      Promise.resolve({ trackStock: input.trackStock, quantity: input.quantity, reserved: 0 }),
    ),
    addOptionGroup: vi.fn((_t, _u, input) =>
      Promise.resolve({ ulid: `G${seq++}`, name: input.name, minSelect: 0, maxSelect: 1 }),
    ),
    addOption: vi.fn((_t, _g, input) =>
      Promise.resolve({
        ulid: `O${seq++}`,
        name: input.name,
        priceDeltaCents: input.priceDeltaCents,
        isAvailable: true,
      }),
    ),
    setOptionAvailability: vi.fn((_t, ulid, isAvailable) => Promise.resolve({ ulid, isAvailable })),
    getPublicMerchant: rejects(),
    updateProfile: rejects(),
    listSettlements: rejects(),
  };
  return { api };
}

describe('menu management', () => {
  it('lists the catalogue (category + product + price)', async () => {
    const { api } = makeApi();
    render(<MenuView api={api} token="tok" />);
    expect(await screen.findByText('Pizza')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Mains' })).toBeInTheDocument();
    expect(screen.getByText('KES 500.00')).toBeInTheDocument();
  });

  it('creates a product → it appears on the board', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<MenuView api={api} token="tok" />);
    await screen.findByText('Pizza');

    await user.click(screen.getByRole('button', { name: 'New product' }));
    const modal = await screen.findByRole('dialog', { name: 'New product' });
    await user.type(within(modal).getByLabelText('Name'), 'Soda');
    await user.type(within(modal).getByLabelText('Price (KES)'), '80');
    await user.click(within(modal).getByRole('button', { name: 'Create product' }));

    expect(await screen.findByText('Soda')).toBeInTheDocument();
    expect(screen.getByText('KES 80.00')).toBeInTheDocument();
  });

  it('edits a price with the current version and bumps it', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<MenuView api={api} token="tok" />);
    await screen.findByText('Pizza');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const drawer = await screen.findByRole('dialog', { name: 'Pizza' });
    const price = within(drawer).getByLabelText('Price (KES)');
    await user.clear(price);
    await user.type(price, '600');
    await user.click(within(drawer).getByRole('button', { name: 'Save details' }));

    expect(api.editProduct).toHaveBeenCalledWith(
      'tok',
      'P1',
      expect.objectContaining({ expectedVersion: 1, priceCents: 60_000 }),
    );
    await waitFor(() => expect(screen.getByText('KES 600.00')).toBeInTheDocument());
  });

  it('toggles availability from the product row', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<MenuView api={api} token="tok" />);
    await screen.findByText('Pizza');

    const toggle = screen.getByRole('switch', { name: 'Toggle availability of Pizza' });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    expect(api.setProductAvailability).toHaveBeenCalledWith('tok', 'P1', false);
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Toggle availability of Pizza' }),
      ).not.toBeChecked(),
    );
  });

  it('surfaces a stale-version conflict as an error', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    (api.editProduct as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(409, 'VERSION_CONFLICT', 'stale'),
    );
    render(<MenuView api={api} token="tok" />);
    await screen.findByText('Pizza');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const drawer = await screen.findByRole('dialog', { name: 'Pizza' });
    await user.click(within(drawer).getByRole('button', { name: 'Save details' }));

    expect(await within(drawer).findByText(/changed elsewhere/i)).toBeInTheDocument();
  });
});
