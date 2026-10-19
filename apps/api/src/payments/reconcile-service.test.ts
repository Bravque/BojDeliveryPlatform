import { describe, expect, it } from 'vitest';
import type { LedgerRepo } from '../ledger/repo';
import type { CaptureService } from './capture-service';
import type { CaptureOutcome, StkCallback } from './capture';
import type { PaymentGateway, StkStatus } from './gateway';
import { createReconcileService } from './reconcile-service';
import type { PaymentRecord, PaymentsRepo } from './repo';

function payment(over: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 1,
    ulid: 'PAY1',
    orderId: 10,
    method: 'simulated',
    amountCents: 40_200,
    currency: 'KES',
    status: 'pending',
    checkoutRequestId: 'SIM-1',
    merchantRequestId: 'SIMMR-1',
    mpesaReceipt: null,
    idempotencyKey: 'k1',
    ...over,
  };
}

function paymentsRepo(open: PaymentRecord[]): PaymentsRepo {
  return { listOpenPayments: () => Promise.resolve(open) } as unknown as PaymentsRepo;
}

function gatewayReturning(status: StkStatus, amountCents: number | null = null): PaymentGateway {
  return {
    initiateStkPush: () => Promise.reject(new Error('unused')),
    queryStkStatus: () =>
      Promise.resolve({
        status,
        resultCode: status === 'success' ? 0 : status === 'failed' ? 1032 : 1037,
        resultDesc: status,
        amountCents,
        mpesaReceipt: status === 'success' ? 'RCPT1' : null,
      }),
  };
}

function captureSpy(): {
  service: CaptureService;
  calls: Array<{ cb: StkCallback; source?: string }>;
} {
  const calls: Array<{ cb: StkCallback; source?: string }> = [];
  const service = {
    processStkResult: (cb: StkCallback, source?: string): Promise<CaptureOutcome> => {
      calls.push({ cb, source });
      return Promise.resolve(cb.resultCode === 0 ? 'captured' : 'failed');
    },
    simulate: () => Promise.resolve('captured' as CaptureOutcome),
  } as unknown as CaptureService;
  return { service, calls };
}

const ledgerOk = { findImbalancedTransactions: () => Promise.resolve([]) } as unknown as LedgerRepo;

describe('reconcile service — reconcilePayment', () => {
  it('captures a pending payment the gateway reports as success', async () => {
    const spy = captureSpy();
    const svc = createReconcileService({
      readRepo: paymentsRepo([]),
      gateway: gatewayReturning('success', 40_200),
      captureService: spy.service,
      ledgerReadRepo: ledgerOk,
    });
    expect(await svc.reconcilePayment(payment())).toBe('captured');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.source).toBe('reconciliation');
    expect(spy.calls[0]?.cb.resultCode).toBe(0);
  });

  it('leaves a still-pending payment alone (no capture call)', async () => {
    const spy = captureSpy();
    const svc = createReconcileService({
      readRepo: paymentsRepo([]),
      gateway: gatewayReturning('pending'),
      captureService: spy.service,
      ledgerReadRepo: ledgerOk,
    });
    expect(await svc.reconcilePayment(payment())).toBe('still_pending');
    expect(spy.calls).toHaveLength(0);
  });

  it('fails a payment the gateway reports as failed', async () => {
    const spy = captureSpy();
    const svc = createReconcileService({
      readRepo: paymentsRepo([]),
      gateway: gatewayReturning('failed'),
      captureService: spy.service,
      ledgerReadRepo: ledgerOk,
    });
    expect(await svc.reconcilePayment(payment())).toBe('failed');
  });

  it('skips a terminal payment', async () => {
    const spy = captureSpy();
    const svc = createReconcileService({
      readRepo: paymentsRepo([]),
      gateway: gatewayReturning('success', 40_200),
      captureService: spy.service,
      ledgerReadRepo: ledgerOk,
    });
    expect(await svc.reconcilePayment(payment({ status: 'succeeded' }))).toBe('skipped');
    expect(spy.calls).toHaveLength(0);
  });
});

describe('reconcile service — batch + report', () => {
  it('summarises a stale-payment sweep', async () => {
    const spy = captureSpy();
    const svc = createReconcileService({
      readRepo: paymentsRepo([payment({ id: 1, ulid: 'A' }), payment({ id: 2, ulid: 'B' })]),
      gateway: gatewayReturning('success', 40_200),
      captureService: spy.service,
      ledgerReadRepo: ledgerOk,
    });
    const summary = await svc.reconcileStalePayments(0);
    expect(summary.scanned).toBe(2);
    expect(summary.captured).toBe(2);
  });

  it('classifies a remote-succeeded-but-local-open payment and reports ledger balance', async () => {
    const svc = createReconcileService({
      readRepo: paymentsRepo([payment()]),
      gateway: gatewayReturning('success', 40_200),
      captureService: captureSpy().service,
      ledgerReadRepo: ledgerOk,
    });
    const report = await svc.reconciliationReport();
    expect(report.ledgerBalanced).toBe(true);
    expect(report.items[0]?.classification).toBe('remote_succeeded_local_open');
  });

  it('flags an amount mismatch in the report', async () => {
    const svc = createReconcileService({
      readRepo: paymentsRepo([payment()]),
      gateway: gatewayReturning('success', 999),
      captureService: captureSpy().service,
      ledgerReadRepo: ledgerOk,
    });
    const report = await svc.reconciliationReport();
    expect(report.items[0]?.classification).toBe('amount_mismatch');
  });

  it('reports an unbalanced ledger', async () => {
    const svc = createReconcileService({
      readRepo: paymentsRepo([]),
      gateway: gatewayReturning('pending'),
      captureService: captureSpy().service,
      ledgerReadRepo: {
        findImbalancedTransactions: () => Promise.resolve([7]),
      } as unknown as LedgerRepo,
    });
    const report = await svc.reconciliationReport();
    expect(report.ledgerBalanced).toBe(false);
    expect(report.imbalancedTransactionCount).toBe(1);
  });
});
