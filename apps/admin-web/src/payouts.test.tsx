import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PayoutsView } from './payouts';
import { fakeApi } from './testApi';
import type { PayoutView } from './api';

const payout = (over: Partial<PayoutView> = {}): PayoutView => ({
  ulid: 'PO1',
  payeeType: 'merchant',
  amountCents: 90_000,
  status: 'draft',
  financeApproved: false,
  opsApproved: false,
  externalRef: null,
  ...over,
});

function makeApi() {
  let list: PayoutView[] = [payout()];
  const update = (ulid: string, patch: Partial<PayoutView>): void => {
    list = list.map((p) => {
      if (p.ulid !== ulid) return p;
      const next = { ...p, ...patch };
      // Both approvals in → ready to execute.
      if (next.financeApproved && next.opsApproved && next.status === 'draft') {
        next.status = 'approved';
      }
      return next;
    });
  };
  const api = fakeApi({
    listPayouts: vi.fn(() => Promise.resolve(list)),
    approvePayoutFinance: vi.fn((_t, ulid) => {
      update(ulid, { financeApproved: true });
      return Promise.resolve(payout({ ulid }));
    }),
    approvePayoutOps: vi.fn((_t, ulid) => {
      update(ulid, { opsApproved: true });
      return Promise.resolve(payout({ ulid }));
    }),
    executePayout: vi.fn((_t, ulid) => {
      update(ulid, { status: 'processing' });
      return Promise.resolve(payout({ ulid, status: 'processing' }));
    }),
  });
  return { api };
}

describe('PayoutsView', () => {
  it('dual-signs then executes a payout', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<PayoutsView api={api} token="tok" />);

    const row = await screen.findByTestId('payout-PO1');
    // Execute is not offered until both approvals are in.
    expect(within(row).queryByRole('button', { name: 'Execute' })).not.toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Approve (finance)' }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('payout-PO1')).queryByRole('button', {
          name: 'Approve (finance)',
        }),
      ).not.toBeInTheDocument(),
    );
    // Still only one approval — no Execute yet.
    expect(
      within(screen.getByTestId('payout-PO1')).queryByRole('button', { name: 'Execute' }),
    ).not.toBeInTheDocument();

    await user.click(
      within(screen.getByTestId('payout-PO1')).getByRole('button', { name: 'Approve (ops)' }),
    );
    const execute = await within(screen.getByTestId('payout-PO1')).findByRole('button', {
      name: 'Execute',
    });
    await user.click(execute);

    await waitFor(() =>
      expect(within(screen.getByTestId('payout-PO1')).getByText('Processing')).toBeInTheDocument(),
    );
    expect(api.approvePayoutFinance).toHaveBeenCalledWith('tok', 'PO1');
    expect(api.approvePayoutOps).toHaveBeenCalledWith('tok', 'PO1');
    expect(api.executePayout).toHaveBeenCalledWith('tok', 'PO1');
  });
});
