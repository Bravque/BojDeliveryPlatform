import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MerchantsView } from './merchants';
import { fakeApi } from './testApi';
import { ApiError, type AdminMerchant, type MerchantSummary } from './api';

const merchant = (over: Partial<AdminMerchant> = {}): AdminMerchant => ({
  ulid: 'M1',
  name: 'Joe Kitchen',
  categoryType: 'restaurant',
  status: 'pending',
  isOpen: false,
  prepMinutes: 20,
  commissionBps: 1000,
  payoutPhoneE164: null,
  townName: 'Migori',
  createdAt: '2026-10-25T09:00:00.000Z',
  ...over,
});

const summary = (over: Partial<MerchantSummary> = {}): MerchantSummary => ({
  ulid: 'M1',
  name: 'Joe Kitchen',
  categoryType: 'restaurant',
  status: 'pending',
  isOpen: false,
  prepMinutes: 20,
  commissionBps: 1000,
  payoutPhoneE164: null,
  ...over,
});

/** A mock backed by a mutable merchant list so mutations are reflected on re-fetch. */
function makeApi() {
  let merchants: AdminMerchant[] = [merchant()];
  const api = fakeApi({
    listMerchants: vi.fn(() => Promise.resolve(merchants)),
    createMerchant: vi.fn((_t, input) => {
      merchants = [merchant({ ulid: 'M2', name: input.name, status: 'pending' }), ...merchants];
      return Promise.resolve(summary({ ulid: 'M2', name: input.name }));
    }),
    approveMerchant: vi.fn((_t, ulid) => {
      merchants = merchants.map((m) => (m.ulid === ulid ? { ...m, status: 'approved' } : m));
      return Promise.resolve(summary({ ulid, status: 'approved' }));
    }),
    suspendMerchant: vi.fn((_t, ulid) => {
      merchants = merchants.map((m) => (m.ulid === ulid ? { ...m, status: 'suspended' } : m));
      return Promise.resolve(summary({ ulid, status: 'suspended' }));
    }),
  });
  return { api };
}

describe('MerchantsView', () => {
  it('lists merchants and approves one from the drawer', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<MerchantsView api={api} token="tok" />);

    const row = await screen.findByTestId('merchant-M1');
    expect(within(row).getByText('Joe Kitchen')).toBeInTheDocument();
    expect(within(row).getByText('Pending')).toBeInTheDocument();

    await user.click(row);
    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(within(screen.getByTestId('merchant-M1')).getByText('Approved')).toBeInTheDocument(),
    );
    expect(api.approveMerchant).toHaveBeenCalledWith('tok', 'M1');
  });

  it('creates a merchant through the modal with the parsed input', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<MerchantsView api={api} token="tok" />);
    await screen.findByTestId('merchant-M1');

    await user.click(screen.getByRole('button', { name: 'New merchant' }));
    await user.type(screen.getByLabelText('Name'), 'New Shop');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(api.createMerchant).toHaveBeenCalledWith(
        'tok',
        expect.objectContaining({
          name: 'New Shop',
          townName: 'Migori',
          categoryType: 'restaurant',
          commissionBps: 1000,
        }),
      ),
    );
    expect(await screen.findByText('New Shop')).toBeInTheDocument();
  });

  it('suspends a merchant with a required reason', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<MerchantsView api={api} token="tok" />);
    await user.click(await screen.findByTestId('merchant-M1'));

    const drawer = await screen.findByRole('dialog');
    const suspend = within(drawer).getByRole('button', { name: 'Suspend' });
    expect(suspend).toBeDisabled();
    await user.type(within(drawer).getByLabelText('Suspend — reason'), 'docs expired');
    await user.click(suspend);

    await waitFor(() =>
      expect(api.suspendMerchant).toHaveBeenCalledWith('tok', 'M1', 'docs expired'),
    );
    await waitFor(() =>
      expect(within(screen.getByTestId('merchant-M1')).getByText('Suspended')).toBeInTheDocument(),
    );
  });

  it('surfaces a server error when creation is rejected', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    (api.createMerchant as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(400, 'BAD_REQUEST', 'Unknown town'),
    );
    render(<MerchantsView api={api} token="tok" />);
    await screen.findByTestId('merchant-M1');

    await user.click(screen.getByRole('button', { name: 'New merchant' }));
    await user.type(screen.getByLabelText('Name'), 'Bad Shop');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown town');
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument(); // modal stays open
  });
});
