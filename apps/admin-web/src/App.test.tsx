import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App, defaultPeriod } from './App';
import { fakeApi } from './testApi';
import type { AuditLogEntry, LedgerOverview, ReconciliationReport, ReportSummary } from './api';

const summary = (over: Partial<ReportSummary> = {}): ReportSummary => ({
  periodStart: '2026-09-25',
  periodEnd: '2026-10-25',
  gmvCents: 1_250_000,
  orderCount: 40,
  deliveredCount: 36,
  cancelledCount: 4,
  refundedCount: 2,
  cancelRate: 0.1,
  refundRate: 0.05,
  byStatus: [{ status: 'delivered', count: 36, totalCents: 1_250_000 }],
  rider: { activeRiders: 5, deliveries: 36, feesCents: 180_000 },
  ...over,
});

const ledger = (over: Partial<LedgerOverview> = {}): LedgerOverview => ({
  generatedAt: '2026-10-25T00:00:00.000Z',
  balanced: true,
  imbalancedTransactionCount: 0,
  accounts: [
    {
      code: 'mpesa_clearing',
      type: 'asset',
      debitCents: 500_000,
      creditCents: 0,
      balanceCents: 500_000,
    },
  ],
  ...over,
});

const report = (over: Partial<ReconciliationReport> = {}): ReconciliationReport => ({
  generatedAt: '2026-10-25T00:00:00.000Z',
  ledgerBalanced: true,
  imbalancedTransactionCount: 0,
  items: [],
  ...over,
});

const auditEntry = (over: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  id: 1,
  actorUserId: 99,
  actorRole: 'admin',
  action: 'merchant.approve',
  entityType: 'merchant',
  entityId: 7,
  before: null,
  after: null,
  createdAt: '2026-10-25T09:00:00.000Z',
  ...over,
});

/** A mock API: one stale divergent payment that disappears once reconcile runs. */
function makeApi() {
  let rpt: ReconciliationReport = report({
    items: [
      {
        paymentUlid: 'P1',
        localStatus: 'pending',
        remoteStatus: 'succeeded',
        amountCents: 40_200,
        classification: 'remote_succeeded_local_open',
      },
    ],
  });
  const api = fakeApi({
    login: vi.fn(() => Promise.resolve({ access: 'tok' })),
    getReportSummary: vi.fn(() => Promise.resolve(summary())),
    getLedger: vi.fn(() => Promise.resolve(ledger())),
    getReconciliationReport: vi.fn(() => Promise.resolve(rpt)),
    runReconcile: vi.fn(() => {
      rpt = report({ items: [] }); // the sweep captured the stale payment
      return Promise.resolve({ scanned: 1, captured: 1, failed: 0, stillPending: 0, other: 0 });
    }),
    listAuditLogs: vi.fn(() => Promise.resolve([auditEntry()])),
  });
  return { api };
}

async function login(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('Email'), 'admin@boj.local');
  await user.type(screen.getByLabelText('Password'), 'DevAdmin!2026');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('admin dashboard — critical journey', () => {
  it('login → overview (summary + ledger + divergence) → reconcile clears divergence → nav to audit', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();

    render(
      <App api={api} initialPeriod={{ periodStart: '2026-09-25', periodEnd: '2026-10-25' }} />,
    );

    await login(user);

    // Overview renders: topbar title + GMV + ledger account + the ledger-balanced line + divergence.
    expect(await screen.findByRole('heading', { name: 'Overview', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('KES 12,500.00')).toBeInTheDocument(); // GMV
    expect(screen.getByTestId('account-mpesa_clearing')).toBeInTheDocument();
    expect(screen.getByTestId('ledger-balanced')).toHaveTextContent('Ledger balanced');
    expect(screen.getByTestId('divergence-P1')).toBeInTheDocument();

    // Run the reconcile sweep → status reports it + the divergence list clears after re-fetch.
    await user.click(screen.getByRole('button', { name: 'Run reconcile' }));
    expect(await screen.findByRole('status')).toHaveTextContent('captured 1');
    await waitFor(() => expect(screen.queryByTestId('divergence-P1')).not.toBeInTheDocument());
    expect(screen.getByText('No divergence.')).toBeInTheDocument();
    expect(api.runReconcile).toHaveBeenCalledTimes(1);

    // Navigate to the audit log → the recent entry is listed.
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    expect(await screen.findByTestId('audit-1')).toHaveTextContent('merchant.approve');
    expect(api.listAuditLogs).toHaveBeenCalledWith('tok');
  });

  it('shows an error on failed login and stays on the form', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    (api.login as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('bad creds'));

    render(<App api={api} />);
    await login(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Login failed');
    await waitFor(() => expect(api.getReportSummary).not.toHaveBeenCalled());
  });

  it('unbuilt sections show a placeholder', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<App api={api} />);
    await login(user);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });

    await user.click(screen.getByRole('button', { name: /Settlements/ }));
    expect(screen.getByText(/coming in a later increment/i)).toBeInTheDocument();
  });

  it('defaultPeriod returns a 30-day window ending today', () => {
    const p = defaultPeriod(new Date('2026-10-25T12:00:00.000Z'));
    expect(p).toEqual({ periodStart: '2026-09-25', periodEnd: '2026-10-25' });
  });
});
