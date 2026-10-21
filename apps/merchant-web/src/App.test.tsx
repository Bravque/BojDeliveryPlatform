import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { ApiClient, MerchantOrders, OrderSummary } from './api';
import type { ConnectMerchantSocket } from './socket';

const order = (over: Partial<OrderSummary> = {}): OrderSummary => ({
  ulid: 'O1',
  orderNumber: 'BOJ-000001',
  status: 'placed',
  paymentStatus: 'paid',
  totalCents: 40_200,
  createdAt: '2026-10-21T00:00:00.000Z',
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
  const api: ApiClient = {
    login: vi.fn(() => Promise.resolve({ access: 'tok' })),
    listMerchantOrders: vi.fn(() => Promise.resolve(orders)),
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
  };
  const addOrder = (o: OrderSummary) => {
    orders = { ...orders, orders: [o, ...orders.orders] };
  };
  return { api, addOrder };
}

describe('merchant dashboard — critical journey', () => {
  it('login → see order → socket nudge re-fetches → accept → preparing → ready', async () => {
    const user = userEvent.setup();
    const { api, addOrder } = makeApi();
    let socketNudge: (() => void) | undefined;
    const connectSocket: ConnectMerchantSocket = (_token, _merchantUlid, onEvent) => {
      socketNudge = onEvent;
      return { close: vi.fn() };
    };

    render(<App api={api} connectSocket={connectSocket} />);

    // Log in.
    await user.type(screen.getByLabelText('Email'), 'owner@joe.local');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // Dashboard + the first order.
    expect(await screen.findByRole('heading', { name: 'Joe Kitchen' })).toBeInTheDocument();
    expect(await screen.findByText(/BOJ-000001 — placed/)).toBeInTheDocument();

    // A realtime nudge arrives for a brand-new order → the dashboard re-fetches and shows it.
    addOrder(order({ ulid: 'O2', orderNumber: 'BOJ-000002' }));
    socketNudge?.();
    expect(await screen.findByRole('status')).toHaveTextContent('New order activity');
    expect(await screen.findByText(/BOJ-000002 — placed/)).toBeInTheDocument();

    // Accept → Start preparing → Mark ready on order O1 (scoped — O2 is also 'placed').
    const o1 = () => within(screen.getByTestId('order-O1'));
    await user.click(o1().getByRole('button', { name: 'Accept' }));
    expect(await screen.findByText(/BOJ-000001 — merchant_accepted/)).toBeInTheDocument();

    await user.click(o1().getByRole('button', { name: 'Start preparing' }));
    expect(await screen.findByText(/BOJ-000001 — preparing/)).toBeInTheDocument();

    await user.click(o1().getByRole('button', { name: 'Mark ready' }));
    expect(await screen.findByText(/BOJ-000001 — ready_for_pickup/)).toBeInTheDocument();
  });

  it('shows an error on failed login and stays on the form', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    (api.login as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('bad creds'));
    render(<App api={api} connectSocket={() => ({ close: vi.fn() })} />);

    await user.type(screen.getByLabelText('Email'), 'owner@joe.local');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Login failed');
    await waitFor(() => expect(api.listMerchantOrders).not.toHaveBeenCalled());
  });
});
