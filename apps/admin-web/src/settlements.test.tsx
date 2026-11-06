import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SettlementsView } from './settlements';
import { fakeApi } from './testApi';
import type { SettlementView } from './api';

const settlement = (over: Partial<SettlementView> = {}): SettlementView => ({
  ulid: 'S1',
  merchantUlid: 'MERCHANTULID0000000001',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  grossCents: 100_000,
  commissionCents: 10_000,
  refundsCents: 0,
  netCents: 90_000,
  status: 'draft',
  ...over,
});

function makeApi() {
  let list: SettlementView[] = [settlement()];
  const api = fakeApi({
    listSettlements: vi.fn(() => Promise.resolve(list)),
    approveSettlement: vi.fn((_t, ulid) => {
      list = list.map((s) => (s.ulid === ulid ? { ...s, status: 'approved' } : s));
      return Promise.resolve(settlement({ ulid, status: 'approved' }));
    }),
    generateSettlements: vi.fn(() =>
      Promise.resolve({ generated: 2, skipped: 1, settlements: [] }),
    ),
  });
  return { api };
}

describe('SettlementsView', () => {
  it('lists settlements and approves a draft', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<SettlementsView api={api} token="tok" />);

    const row = await screen.findByTestId('settlement-S1');
    expect(within(row).getByText('KES 900.00')).toBeInTheDocument(); // net
    await user.click(within(row).getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(within(screen.getByTestId('settlement-S1')).getByText('Approved')).toBeInTheDocument(),
    );
    expect(api.approveSettlement).toHaveBeenCalledWith('tok', 'S1');
  });

  it('generates settlements for the period and reports the counts', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<SettlementsView api={api} token="tok" />);
    await screen.findByTestId('settlement-S1');

    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Generated 2, skipped 1');
    expect(api.generateSettlements).toHaveBeenCalledTimes(1);
  });
});
