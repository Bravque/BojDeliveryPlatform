import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RefundsView } from './refunds';
import { fakeApi } from './testApi';
import { ApiError, type RefundListItem } from './api';

const refund = (over: Partial<RefundListItem> = {}): RefundListItem => ({
  ulid: 'R1',
  orderUlid: 'ORD1',
  orderNumber: 'BOJ-000001',
  status: 'requested',
  source: 'manual',
  amountCents: 5_000,
  reason: 'customer dispute',
  providerRef: null,
  createdAt: '2026-10-25T09:00:00.000Z',
  ...over,
});

function makeApi() {
  let list: RefundListItem[] = [refund()];
  const api = fakeApi({
    listRefunds: vi.fn(() => Promise.resolve(list)),
    approveRefund: vi.fn((_t, ulid) => {
      list = list.map((r) => (r.ulid === ulid ? { ...r, status: 'processing' } : r));
      return Promise.resolve({ ...refund({ ulid }), status: 'processing' });
    }),
    rejectRefund: vi.fn((_t, ulid) => {
      list = list.map((r) => (r.ulid === ulid ? { ...r, status: 'rejected' } : r));
      return Promise.resolve({ ...refund({ ulid }), status: 'rejected' });
    }),
  });
  return { api };
}

describe('RefundsView', () => {
  it('approves a requested refund', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<RefundsView api={api} token="tok" />);

    const row = await screen.findByTestId('refund-R1');
    expect(within(row).getByText('BOJ-000001')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(within(screen.getByTestId('refund-R1')).getByText('Processing')).toBeInTheDocument(),
    );
    expect(api.approveRefund).toHaveBeenCalledWith('tok', 'R1');
  });

  it('surfaces the separation-of-duties 403 from approve', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    (api.approveRefund as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(403, 'FORBIDDEN', 'Requester cannot approve their own refund'),
    );
    render(<RefundsView api={api} token="tok" />);
    await user.click(
      within(await screen.findByTestId('refund-R1')).getByRole('button', { name: 'Approve' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Requester cannot approve');
  });
});
