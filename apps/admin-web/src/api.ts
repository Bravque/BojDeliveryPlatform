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

/** `MerchantSummary` returned by the admin merchant mutations. */
export interface MerchantSummary {
  ulid: string;
  name: string;
  categoryType: string;
  status: string;
  isOpen: boolean;
  prepMinutes: number;
  commissionBps: number;
  payoutPhoneE164: string | null;
}

/** `GET /api/v1/admin/merchants` item — summary enriched with town + creation time. */
export interface AdminMerchant extends MerchantSummary {
  townName: string;
  createdAt: string;
}

export interface CreateMerchantInput {
  townName: string;
  name: string;
  categoryType: string;
  commissionBps: number;
  prepMinutes?: number;
  ownerUserUlid?: string;
}

/** `RiderSummary` returned by the admin rider mutations. */
export interface RiderSummary {
  userUlid: string;
  status: string;
  vehicleType: string;
  isOnline: boolean;
  payoutPhoneE164: string | null;
}

/** `GET /api/v1/admin/riders` item — summary enriched with sign-in phone + application time. */
export interface AdminRider extends RiderSummary {
  phoneE164: string | null;
  createdAt: string;
}

/** `GET /api/v1/admin/settlements` item — mirrors `SettlementView`. */
export interface SettlementView {
  ulid: string;
  merchantUlid: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  commissionCents: number;
  refundsCents: number;
  netCents: number;
  status: string;
}

export interface GenerateSettlementsResult {
  generated: number;
  skipped: number;
  settlements: SettlementView[];
}

/** `GET /api/v1/admin/payouts` item — mirrors `PayoutView`. */
export interface PayoutView {
  ulid: string;
  payeeType: string;
  amountCents: number;
  status: string;
  financeApproved: boolean;
  opsApproved: boolean;
  externalRef: string | null;
}

export interface GeneratePayoutsResult {
  generated: number;
  skipped: number;
  payouts: PayoutView[];
}

/** `GET /api/v1/admin/refunds` item — mirrors `RefundListItem`. */
export interface RefundListItem {
  ulid: string;
  orderUlid: string | null;
  orderNumber: string | null;
  status: string;
  source: string;
  amountCents: number;
  reason: string;
  providerRef: string | null;
  createdAt: string;
}

/** `POST /api/v1/refunds/:ulid/{approve,reject}` — mirrors `RefundView`. */
export interface RefundView {
  ulid: string;
  orderUlid: string | null;
  status: string;
  source: string;
  amountCents: number;
  reason: string;
  providerRef: string | null;
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

  // --- operations: merchants ---
  listMerchants(token: string): Promise<AdminMerchant[]>;
  createMerchant(token: string, input: CreateMerchantInput): Promise<MerchantSummary>;
  approveMerchant(token: string, ulid: string): Promise<MerchantSummary>;
  suspendMerchant(token: string, ulid: string, reason: string): Promise<MerchantSummary>;
  setMerchantPayoutDestination(
    token: string,
    ulid: string,
    phone: string,
  ): Promise<MerchantSummary>;
  addMerchantOwner(
    token: string,
    ulid: string,
    userUlid: string,
    role: 'owner' | 'staff',
  ): Promise<MerchantSummary>;

  // --- operations: riders ---
  listRiders(token: string): Promise<AdminRider[]>;
  approveRider(token: string, ulid: string): Promise<RiderSummary>;
  suspendRider(token: string, ulid: string, reason: string): Promise<RiderSummary>;

  // --- finance: settlements ---
  listSettlements(token: string): Promise<SettlementView[]>;
  generateSettlements(token: string, period: Period): Promise<GenerateSettlementsResult>;
  approveSettlement(token: string, ulid: string): Promise<SettlementView>;

  // --- finance: payouts ---
  listPayouts(token: string): Promise<PayoutView[]>;
  generatePayouts(token: string, period: Period): Promise<GeneratePayoutsResult>;
  approvePayoutFinance(token: string, ulid: string): Promise<PayoutView>;
  approvePayoutOps(token: string, ulid: string): Promise<PayoutView>;
  executePayout(token: string, ulid: string): Promise<PayoutView>;

  // --- finance: refunds ---
  listRefunds(token: string): Promise<RefundListItem[]>;
  approveRefund(token: string, ulid: string): Promise<RefundView>;
  rejectRefund(token: string, ulid: string): Promise<RefundView>;
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

    async listMerchants(token) {
      const res = await request<{ items: AdminMerchant[] }>('GET', '/api/v1/admin/merchants', {
        token,
      });
      return res.items;
    },
    createMerchant(token, input) {
      return request<MerchantSummary>('POST', '/api/v1/admin/merchants', { token, body: input });
    },
    approveMerchant(token, ulid) {
      return request<MerchantSummary>('POST', `/api/v1/admin/merchants/${ulid}/approve`, { token });
    },
    suspendMerchant(token, ulid, reason) {
      return request<MerchantSummary>('POST', `/api/v1/admin/merchants/${ulid}/suspend`, {
        token,
        body: { reason },
      });
    },
    setMerchantPayoutDestination(token, ulid, phone) {
      return request<MerchantSummary>(
        'POST',
        `/api/v1/admin/merchants/${ulid}/payout-destination`,
        {
          token,
          body: { phone },
        },
      );
    },
    addMerchantOwner(token, ulid, userUlid, role) {
      return request<MerchantSummary>('POST', `/api/v1/admin/merchants/${ulid}/owners`, {
        token,
        body: { userUlid, role },
      });
    },

    async listRiders(token) {
      const res = await request<{ items: AdminRider[] }>('GET', '/api/v1/admin/riders', { token });
      return res.items;
    },
    approveRider(token, ulid) {
      return request<RiderSummary>('POST', `/api/v1/admin/riders/${ulid}/approve`, { token });
    },
    suspendRider(token, ulid, reason) {
      return request<RiderSummary>('POST', `/api/v1/admin/riders/${ulid}/suspend`, {
        token,
        body: { reason },
      });
    },

    async listSettlements(token) {
      const res = await request<{ items: SettlementView[] }>('GET', '/api/v1/admin/settlements', {
        token,
      });
      return res.items;
    },
    generateSettlements(token, period) {
      return request<GenerateSettlementsResult>('POST', '/api/v1/admin/settlements/generate', {
        token,
        body: period,
      });
    },
    approveSettlement(token, ulid) {
      return request<SettlementView>('POST', `/api/v1/admin/settlements/${ulid}/approve`, {
        token,
      });
    },

    async listPayouts(token) {
      const res = await request<{ items: PayoutView[] }>('GET', '/api/v1/admin/payouts', { token });
      return res.items;
    },
    generatePayouts(token, period) {
      return request<GeneratePayoutsResult>('POST', '/api/v1/admin/payouts/generate', {
        token,
        body: period,
      });
    },
    approvePayoutFinance(token, ulid) {
      return request<PayoutView>('POST', `/api/v1/admin/payouts/${ulid}/approve-finance`, {
        token,
      });
    },
    approvePayoutOps(token, ulid) {
      return request<PayoutView>('POST', `/api/v1/admin/payouts/${ulid}/approve-ops`, { token });
    },
    executePayout(token, ulid) {
      return request<PayoutView>('POST', `/api/v1/admin/payouts/${ulid}/execute`, { token });
    },

    async listRefunds(token) {
      const res = await request<{ items: RefundListItem[] }>('GET', '/api/v1/admin/refunds', {
        token,
      });
      return res.items;
    },
    approveRefund(token, ulid) {
      return request<RefundView>('POST', `/api/v1/refunds/${ulid}/approve`, { token });
    },
    rejectRefund(token, ulid) {
      return request<RefundView>('POST', `/api/v1/refunds/${ulid}/reject`, { token });
    },
  };
}
