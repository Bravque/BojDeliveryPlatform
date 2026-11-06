import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AuditView } from './audit';
import type { ApiClient, AuditLogEntry } from './api';

const entry = (over: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  id: 1,
  actorUserId: 99,
  actorRole: 'finance',
  action: 'settlement.approve',
  entityType: 'settlement',
  entityId: 3,
  before: null,
  after: null,
  createdAt: '2026-10-25T09:00:00.000Z',
  ...over,
});

function makeApi(entries: AuditLogEntry[]): ApiClient {
  return {
    login: vi.fn(),
    getReportSummary: vi.fn(),
    getLedger: vi.fn(),
    getReconciliationReport: vi.fn(),
    runReconcile: vi.fn(),
    listAuditLogs: vi.fn(() => Promise.resolve(entries)),
  };
}

describe('AuditView', () => {
  it('lists recent audit entries', async () => {
    const api = makeApi([entry(), entry({ id: 2, action: 'merchant.create', actorRole: 'admin' })]);
    render(<AuditView api={api} token="tok" />);
    expect(await screen.findByTestId('audit-1')).toHaveTextContent('settlement.approve');
    expect(screen.getByTestId('audit-2')).toHaveTextContent('merchant.create');
  });

  it('shows an empty state when there are no entries', async () => {
    const api = makeApi([]);
    render(<AuditView api={api} token="tok" />);
    expect(await screen.findByText('No audit entries yet.')).toBeInTheDocument();
  });

  it('refreshes on demand', async () => {
    const user = userEvent.setup();
    const api = makeApi([entry()]);
    render(<AuditView api={api} token="tok" />);
    await screen.findByTestId('audit-1');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.listAuditLogs).toHaveBeenCalledTimes(2));
  });
});
