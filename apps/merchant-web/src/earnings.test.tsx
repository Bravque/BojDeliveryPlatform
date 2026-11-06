import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EarningsView } from './earnings';
import type { ApiClient, SettlementView } from './api';

const settlement = (over: Partial<SettlementView> = {}): SettlementView => ({
  ulid: 'S1',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-07',
  grossCents: 110_000,
  commissionCents: 11_000,
  refundsCents: 0,
  netCents: 99_000,
  status: 'approved',
  ...over,
});

function apiWith(items: SettlementView[]): ApiClient {
  return { listSettlements: vi.fn(() => Promise.resolve(items)) } as unknown as ApiClient;
}

describe('earnings', () => {
  it('lists settlements with the period, net, and a running total', async () => {
    render(<EarningsView api={apiWith([settlement()])} token="tok" />);
    expect(await screen.findByText('2026-10-01 → 2026-10-07')).toBeInTheDocument();
    expect(screen.getByText('KES 990.00')).toBeInTheDocument(); // net figure
    expect(screen.getByText(/Net to date/)).toHaveTextContent('KES 990.00');
  });

  it('shows an empty state when there are no settlements', async () => {
    render(<EarningsView api={apiWith([])} token="tok" />);
    expect(await screen.findByText(/No settlements yet/)).toBeInTheDocument();
  });
});
