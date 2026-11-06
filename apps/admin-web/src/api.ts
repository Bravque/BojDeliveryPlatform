/**
 * Typed REST client for the admin console. Canonical state always comes from here; the UI never
 * trusts client-side money or roles — every mutation is gated server-side. Types mirror the server
 * DTOs (`reports/report-service.ts`, `payments/reconcile-service.ts`, `auth/repo.ts`). Grows one
 * section at a time, matching the dashboard increments. (A shared OpenAPI-generated client across
 * all frontends is still deferred to the broader client-apps track.)
 */

export interface LoginResult {
  access: string;
}

export interface Period {
  periodStart: string;
  periodEnd: string;
}

/** `GET /api/v1/admin/reports/summary` — mirrors `ReportSummary`. */
export interface ReportSummary {
  periodStart: string;
  periodEnd: string;
  gmvCents: number;
  orderCount: number;
  deliveredCount: number;
  cancelledCount: number;
  refundedCount: number;
  cancelRate: number;
  refundRate: number;
  byStatus: Array<{ status: string; count: number; totalCents: number }>;
  rider: { activeRiders: number; deliveries: number; feesCents: number };
}

/** `GET /api/v1/admin/reports/ledger` — mirrors `LedgerOverview`. */
export interface LedgerOverview {
  generatedAt: string;
  balanced: boolean;
  imbalancedTransactionCount: number;
  accounts: Array<{
    code: string;
    type: 'asset' | 'liability' | 'revenue' | 'expense';
    debitCents: number;
    creditCents: number;
    balanceCents: number;
  }>;
}

/** `GET /api/v1/admin/payments/reconciliation-report` — mirrors `ReconciliationReport`. */
export interface ReconciliationReport {
  generatedAt: string;
  ledgerBalanced: boolean;
  imbalancedTransactionCount: number;
  items: Array<{
    paymentUlid: string;
    localStatus: string;
    remoteStatus: string;
    amountCents: number;
    classification: string;
  }>;
}

/** `POST /api/v1/admin/payments/reconcile` — mirrors `ReconcileSummary`. */
export interface ReconcileSummary {
  scanned: number;
  captured: number;
  failed: number;
  stillPending: number;
  other: number;
}

/** `GET /api/v1/admin/audit-logs` item — mirrors `AuditLogRecord`. */
export interface AuditLogEntry {
  id: number;
  actorUserId: number | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: number | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    message?: string,
  ) {
    super(message ?? `Request failed: ${status}`);
    this.name = 'ApiError';
  }
}

export interface ApiClient {
  login(email: string, password: string): Promise<LoginResult>;
  getReportSummary(token: string, period: Period): Promise<ReportSummary>;
  getLedger(token: string): Promise<LedgerOverview>;
  getReconciliationReport(token: string): Promise<ReconciliationReport>;
  runReconcile(token: string): Promise<ReconcileSummary>;
  listAuditLogs(token: string): Promise<AuditLogEntry[]>;
}

export function createHttpApiClient(baseUrl: string): ApiClient {
  async function request<T>(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    if (!res.ok) {
      let code: string | undefined;
      let message: string | undefined;
      try {
        const parsed = (await res.json()) as { error?: { code?: string; message?: string } };
        code = parsed.error?.code;
        message = parsed.error?.message;
      } catch {
        // non-JSON error body
      }
      throw new ApiError(res.status, code, message);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  return {
    login(email, password) {
      return request<LoginResult>('POST', '/api/v1/auth/password/login', {
        body: { email, password },
      });
    },
    getReportSummary(token, period) {
      const q = `?periodStart=${period.periodStart}&periodEnd=${period.periodEnd}`;
      return request<ReportSummary>('GET', `/api/v1/admin/reports/summary${q}`, { token });
    },
    getLedger(token) {
      return request<LedgerOverview>('GET', '/api/v1/admin/reports/ledger', { token });
    },
    getReconciliationReport(token) {
      return request<ReconciliationReport>('GET', '/api/v1/admin/payments/reconciliation-report', {
        token,
      });
    },
    runReconcile(token) {
      return request<ReconcileSummary>('POST', '/api/v1/admin/payments/reconcile', {
        token,
        body: {},
      });
    },
    async listAuditLogs(token) {
      const res = await request<{ items: AuditLogEntry[] }>('GET', '/api/v1/admin/audit-logs', {
        token,
      });
      return res.items;
    },
  };
}
