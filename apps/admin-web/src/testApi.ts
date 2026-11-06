import { vi } from 'vitest';
import type { ApiClient } from './api';

/**
 * A fully-stubbed `ApiClient` for vitest+RTL tests. Every method defaults to `vi.fn()`; a test
 * overrides only the methods it exercises. This keeps each section's tests focused and means adding
 * a method to `ApiClient` doesn't churn unrelated test mocks.
 */
export function fakeApi(over: Partial<ApiClient> = {}): ApiClient {
  return {
    login: vi.fn(),
    getReportSummary: vi.fn(),
    getLedger: vi.fn(),
    getReconciliationReport: vi.fn(),
    runReconcile: vi.fn(),
    listAuditLogs: vi.fn(),
    listMerchants: vi.fn(),
    createMerchant: vi.fn(),
    approveMerchant: vi.fn(),
    suspendMerchant: vi.fn(),
    setMerchantPayoutDestination: vi.fn(),
    addMerchantOwner: vi.fn(),
    listRiders: vi.fn(),
    approveRider: vi.fn(),
    suspendRider: vi.fn(),
    ...over,
  };
}
