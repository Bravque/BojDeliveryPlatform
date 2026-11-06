import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OverviewView } from './overview';
import type { ApiClient, LedgerOverview, ReconciliationReport, ReportSummary } from './api';

const PERIOD = { periodStart: '2026-09-25', periodEnd: '2026-10-25' };

const summary: ReportSummary = {
  periodStart: '2026-09-25',
  periodEnd: '2026-10-25',
  gmvCents: 1_250_000,
  orderCount: 40,
  deliveredCount: 36,
  cancelledCount: 4,
  refundedCount: 2,
  cancelRate: 0.1,
  refundRate: 0.05,
  byStatus: [],
  rider: { activeRiders: 5, deliveries: 36, feesCents: 180_000 },
};

const ledger: LedgerOverview = {
  generatedAt: '2026-10-25T00:00:00.000Z',
  balanced: true,
  imbalancedTransactionCount: 0,
  accounts: [
    {
      code: 'commission_revenue',
      type: 'revenue',
      debitCents: 0,
      creditCents: 3_020,
      balanceCents: 3_020,
    },
  ],
};

function makeApi(reportItems: ReconciliationReport['items'] = []): ApiClient {
  let rpt: ReconciliationReport = {
    generatedAt: '2026-10-25T00:00:00.000Z',
    ledgerBalanced: true,
    imbalancedTransactionCount: 0,
    items: reportItems,
  };
  return {
    login: vi.fn(),
    getReportSummary: vi.fn(() => Promise.resolve(summary)),
    getLedger: vi.fn(() => Promise.resolve(ledger)),
    getReconciliationReport: vi.fn(() => Promise.resolve(rpt)),
    runReconcile: vi.fn(() => {
      rpt = { ...rpt, items: [] };
      return Promise.resolve({ scanned: 2, captured: 1, failed: 0, stillPending: 1, other: 0 });
    }),
    listAuditLogs: vi.fn(),
  };
}

describe('OverviewView', () => {
  it('renders KPIs, ledger accounts and divergence, then reconcile clears divergence', async () => {
    const user = userEvent.setup();
    const api = makeApi([
      {
        paymentUlid: 'P9',
        localStatus: 'pending',
        remoteStatus: 'succeeded',
        amountCents: 40_200,
        classification: 'remote_succeeded_local_open',
      },
    ]);
    render(<OverviewView api={api} token="tok" initialPeriod={PERIOD} />);

    expect(await screen.findByText('KES 12,500.00')).toBeInTheDocument(); // GMV
    expect(screen.getByText('10.00%')).toBeInTheDocument(); // cancel rate
    expect(screen.getByTestId('account-commission_revenue')).toBeInTheDocument();
    expect(screen.getByTestId('divergence-P9')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Run reconcile' }));
    expect(await screen.findByRole('status')).toHaveTextContent('captured 1');
    await waitFor(() => expect(screen.queryByTestId('divergence-P9')).not.toBeInTheDocument());
  });

  it('re-fetches the summary for a new period on Apply', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    render(<OverviewView api={api} token="tok" initialPeriod={PERIOD} />);
    await screen.findByText('KES 12,500.00');
    expect(api.getReportSummary).toHaveBeenLastCalledWith('tok', PERIOD);

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(api.getReportSummary).toHaveBeenLastCalledWith('tok', {
        periodStart: '2026-10-01',
        periodEnd: '2026-10-25',
      }),
    );
  });

  it('shows an error when the overview fails to load', async () => {
    const api = makeApi();
    (api.getLedger as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    render(<OverviewView api={api} token="tok" initialPeriod={PERIOD} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load the overview.');
  });
});
