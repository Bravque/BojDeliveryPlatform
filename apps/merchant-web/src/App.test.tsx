import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { ApiClient, MerchantOrderDetail, MerchantOrders, OrderSummary } from './api';
import type { ConnectMerchantSocket } from './socket';

const order = (over: Partial<OrderSummary> = {}): OrderSummary => ({
  ulid: 'O1',
  orderNumber: 'BOJ-000001',
  status: 'placed',
  paymentStatus: 'paid',
  totalCents: 120_000,
  createdAt: new Date().toISOString(),
  ...over,
});

/** A mock API whose order status advances as the merchant acts (mirrors the backend transitions). */
function makeApi() {
  let orders: MerchantOrders = {
    merchant: { ulid: 'M1', name: 'Joe Kitchen' },
    orders: [order()],
  };
  const advance = (ulid: string, status: string) => {
    orders = {
      ...orders,
      orders: orders.orders.map((o) => (o.ulid === ulid ? { ...o, status } : o)),
    };
  };
  const detailFor = (ulid: string): MerchantOrderDetail => {
    const o = orders.orders.find((x) => x.ulid === ulid);
    return {
      ulid,
      orderNumber: o?.orderNumber ?? 'BOJ',
      status: o?.status ?? 'placed',
      paymentStatus: 'paid',
      currency: 'KES',
      items: [
        {
          productUlid: 'P1',
          name: 'Pizza',
          unitPriceCents: 50_000,
          quantity: 2,
          lineTotalCents: 120_000,
          options: [{ name: 'Large', priceDeltaCents: 10_000 }],
        },
      ],
      subtotalCents: 110_000,
      deliveryFeeCents: 10_000,
      serviceFeeCents: 0,
      discountCents: 0,
      commissionCents: 11_000,
      totalCents: 120_000,
      createdAt: new Date().toISOString(),
    };
  };
  const api: ApiClient = {
    login: vi.fn(() => Promise.resolve({ access: 'tok' })),
    listMerchantOrders: vi.fn(() => Promise.resolve(orders)),
    getMerchantOrder: vi.fn((_t, ulid) => Promise.resolve(detailFor(ulid))),
    acceptOrder: vi.fn((_t, ulid) => {
      advance(ulid, 'merchant_accepted');
      return Promise.resolve();
    }),
    startPreparing: vi.fn((_t, ulid) => {
      advance(ulid, 'preparing');
      return Promise.resolve();
    }),
    markReady: vi.fn((_t, ulid) => {
      advance(ulid, 'ready_for_pickup');
      return Promise.resolve();
    }),
    rejectOrder: vi.fn((_t, ulid) => {
      advance(ulid, 'rejected');
      return Promise.resolve();
    }),
    // Catalogue methods are unused by the orders journey (covered in menu.test.tsx).
    getCatalogue: vi.fn(() => Promise.reject(new Error('not used'))),
    createCategory: vi.fn(() => Promise.reject(new Error('not used'))),
    createProduct: vi.fn(() => Promise.reject(new Error('not used'))),
    editProduct: vi.fn(() => Promise.reject(new Error('not used'))),
    setProductAvailability: vi.fn(() => Promise.reject(new Error('not used'))),
    setInventory: vi.fn(() => Promise.reject(new Error('not used'))),
    addOptionGroup: vi.fn(() => Promise.reject(new Error('not used'))),
    addOption: vi.fn(() => Promise.reject(new Error('not used'))),
    setOptionAvailability: vi.fn(() => Promise.reject(new Error('not used'))),
  };
  const addOrder = (o: OrderSummary) => {
    orders = { ...orders, orders: [o, ...orders.orders] };
  };
  return { api, addOrder };
}

const noSocket: ConnectMerchantSocket = () => ({ close: vi.fn() });

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

async function login(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'owner@joe.local');
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('merchant dashboard — critical journey', () => {
  it('login → see order → socket nudge re-fetches → open → accept → preparing → ready', async () => {
    const user = userEvent.setup();
    const { api, addOrder } = makeApi();
    let socketNudge: (() => void) | undefined;
    const connectSocket: ConnectMerchantSocket = (_t, _m, onEvent) => {
      socketNudge = onEvent;
      return { close: vi.fn() };
    };

    render(<App api={api} connectSocket={connectSocket} />);
    await login(user);

    expect(await screen.findByRole('heading', { name: 'Joe Kitchen' })).toBeInTheDocument();
    expect(await screen.findByTestId('order-O1')).toHaveTextContent('BOJ-000001');

    // A realtime nudge for a brand-new order → re-fetch + toast + new card.
    addOrder(order({ ulid: 'O2', orderNumber: 'BOJ-000002' }));
    await act(async () => {
      socketNudge?.();
    });
    expect(await screen.findByRole('status')).toHaveTextContent('New order activity');
    expect(await screen.findByTestId('order-O2')).toBeInTheDocument();

    // Open O1 → drawer → walk Accept → Start preparing → Mark ready (buttons change as status advances).
    await user.click(screen.getByTestId('order-O1'));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Pizza')).toBeInTheDocument();

    await user.click(await within(drawer).findByRole('button', { name: 'Accept' }));
    await user.click(await within(drawer).findByRole('button', { name: 'Start preparing' }));
    await user.click(await within(drawer).findByRole('button', { name: 'Mark ready' }));

    // O1 lands in the Ready column; no further actions in the drawer.
    await waitFor(() =>
      expect(within(screen.getByLabelText('Ready')).getByTestId('order-O1')).toBeInTheDocument(),
    );
    expect(api.markReady).toHaveBeenCalledWith('tok', 'O1');
  });

  it('rejects an order with a reason → it moves to History', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<App api={api} connectSocket={noSocket} />);
    await login(user);

    await user.click(await screen.findByTestId('order-O1'));
    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Reject' }));
    await user.type(within(drawer).getByLabelText('Rejection reason'), 'out of stock');
    await user.click(within(drawer).getByRole('button', { name: 'Confirm reject' }));

    expect(api.rejectOrder).toHaveBeenCalledWith('tok', 'O1', 'out of stock');
    await waitFor(() =>
      expect(within(screen.getByLabelText('History')).getByTestId('order-O1')).toBeInTheDocument(),
    );
  });

  it('shows an error on failed login and stays on the form', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    (api.login as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('bad creds'));
    render(<App api={api} connectSocket={noSocket} />);

    await login(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Login failed');
    await waitFor(() => expect(api.listMerchantOrders).not.toHaveBeenCalled());
  });

  it('restores a persisted session from localStorage without re-login', async () => {
    window.localStorage.setItem('boj.merchant.token', 'tok');
    const { api } = makeApi();
    render(<App api={api} connectSocket={noSocket} />);

    expect(await screen.findByRole('heading', { name: 'Joe Kitchen' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(api.listMerchantOrders).toHaveBeenCalledWith('tok');
  });
});
