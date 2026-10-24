/**
 * Thin typed REST client for the admin dashboard. The canonical state always comes from here;
 * this MVP overview is read-mostly (reports + reconciliation) plus one idempotent admin action
 * (reconcile sweep). Types mirror the server DTOs (`reports/report-service.ts`,
 * `payments/reconcile-service.ts`). (A shared OpenAPI-generated client across all frontends is
 * still deferred to the broader client-apps track.)
 */

export interface LoginResult {
  access: string;
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

export interface Period {
  periodStart: string;
  periodEnd: string;
}

export interface ApiClient {
  login(email: string, password: string): Promise<LoginResult>;
  getReportSummary(token: string, period: Period): Promise<ReportSummary>;
  getReconciliationReport(token: string): Promise<ReconciliationReport>;
  runReconcile(token: string): Promise<ReconcileSummary>;
}

export function createHttpApiClient(baseUrl: string): ApiClient {
  async function get<T>(path: string, token: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  return {
    async login(email, password) {
      return post<LoginResult>('/api/v1/auth/password/login', { email, password });
    },
    async getReportSummary(token, period) {
      const q = `?periodStart=${period.periodStart}&periodEnd=${period.periodEnd}`;
      return get<ReportSummary>(`/api/v1/admin/reports/summary${q}`, token);
    },
    async getReconciliationReport(token) {
      return get<ReconciliationReport>('/api/v1/admin/payments/reconciliation-report', token);
    },
    async runReconcile(token) {
      return post<ReconcileSummary>('/api/v1/admin/payments/reconcile', {}, token);
    },
  };
}
