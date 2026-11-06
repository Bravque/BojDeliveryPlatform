import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RidersView } from './riders';
import { fakeApi } from './testApi';
import { type AdminRider, type RiderSummary } from './api';

const rider = (over: Partial<AdminRider> = {}): AdminRider => ({
  userUlid: 'U1',
  status: 'pending',
  vehicleType: 'motorbike',
  isOnline: false,
  payoutPhoneE164: null,
  phoneE164: '+254712345678',
  createdAt: '2026-10-25T09:00:00.000Z',
  ...over,
});

const summary = (over: Partial<RiderSummary> = {}): RiderSummary => ({
  userUlid: 'U1',
  status: 'pending',
  vehicleType: 'motorbike',
  isOnline: false,
  payoutPhoneE164: null,
  ...over,
});

function makeApi() {
  let riders: AdminRider[] = [rider()];
  const api = fakeApi({
    listRiders: vi.fn(() => Promise.resolve(riders)),
    approveRider: vi.fn((_t, ulid) => {
      riders = riders.map((r) => (r.userUlid === ulid ? { ...r, status: 'approved' } : r));
      return Promise.resolve(summary({ userUlid: ulid, status: 'approved' }));
    }),
    suspendRider: vi.fn((_t, ulid) => {
      riders = riders.map((r) => (r.userUlid === ulid ? { ...r, status: 'suspended' } : r));
      return Promise.resolve(summary({ userUlid: ulid, status: 'suspended' }));
    }),
  });
  return { api };
}

describe('RidersView', () => {
  it('lists riders and approves one from the drawer', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<RidersView api={api} token="tok" />);

    const row = await screen.findByTestId('rider-U1');
    expect(within(row).getByText('+254712345678')).toBeInTheDocument();
    expect(within(row).getByText('Pending')).toBeInTheDocument();

    await user.click(row);
    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(within(screen.getByTestId('rider-U1')).getByText('Approved')).toBeInTheDocument(),
    );
    expect(api.approveRider).toHaveBeenCalledWith('tok', 'U1');
  });

  it('suspends a rider with a required reason', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<RidersView api={api} token="tok" />);
    await user.click(await screen.findByTestId('rider-U1'));

    const drawer = await screen.findByRole('dialog');
    const suspend = within(drawer).getByRole('button', { name: 'Suspend' });
    expect(suspend).toBeDisabled();
    await user.type(within(drawer).getByLabelText('Suspend — reason'), 'documents expired');
    await user.click(suspend);

    await waitFor(() =>
      expect(api.suspendRider).toHaveBeenCalledWith('tok', 'U1', 'documents expired'),
    );
    await waitFor(() =>
      expect(within(screen.getByTestId('rider-U1')).getByText('Suspended')).toBeInTheDocument(),
    );
  });
});
