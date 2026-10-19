import type { LedgerRepo } from '../ledger/repo';
import type { CaptureService } from './capture-service';
import type { CaptureOutcome, StkCallback } from './capture';
import type { PaymentGateway } from './gateway';
import type { PaymentRecord, PaymentsRepo } from './repo';

/**
 * Reconciliation (doc 07 §5–6). Resolves stale `pending`/`initiated` payments by querying the
 * gateway and applying the result through the capture service (idempotent), and produces a
 * read-only report of local-vs-remote divergence + a ledger-balance invariant check. No automatic
 * money movement beyond resolving a stuck STK outcome; true anomalies are surfaced for ops.
 *
 * The late-success-after-cancel → auto-refund edge is handled in increment 5 (refunds), where the
 * refund/ledger-reversal primitive exists.
 */

export type ReconcileOutcome = CaptureOutcome | 'still_pending' | 'skipped';

export interface ReconcileSummary {
  scanned: number;
  captured: number;
  failed: number;
  stillPending: number;
  other: number;
}

export type ReportClassification =
  'remote_succeeded_local_open' | 'remote_failed_local_open' | 'amount_mismatch' | 'pending';

export interface ReconciliationReportItem {
  paymentUlid: string;
  localStatus: string;
  remoteStatus: string;
  amountCents: number;
  classification: ReportClassification;
}

export interface ReconciliationReport {
  generatedAt: string;
  ledgerBalanced: boolean;
  imbalancedTransactionCount: number;
  items: ReconciliationReportItem[];
}

export interface ReconcileServiceDeps {
  readRepo: PaymentsRepo;
  gateway: PaymentGateway;
  captureService: CaptureService;
  ledgerReadRepo: LedgerRepo;
}

export function createReconcileService(deps: ReconcileServiceDeps) {
  const { readRepo, gateway, captureService, ledgerReadRepo } = deps;

  async function reconcilePayment(payment: PaymentRecord): Promise<ReconcileOutcome> {
    if (payment.status !== 'pending' && payment.status !== 'initiated') {
      return 'skipped';
    }
    if (!payment.checkoutRequestId) {
      return 'skipped';
    }
    const remote = await gateway.queryStkStatus(payment.checkoutRequestId);
    if (remote.status === 'pending') {
      return 'still_pending';
    }
    const callback: StkCallback = {
      checkoutRequestId: payment.checkoutRequestId,
      resultCode: remote.resultCode,
      resultDesc: remote.resultDesc,
      amountCents: remote.amountCents,
      mpesaReceipt: remote.mpesaReceipt,
    };
    return captureService.processStkResult(callback, 'reconciliation');
  }

  async function reconcileStalePayments(olderThanSec = 120): Promise<ReconcileSummary> {
    const cutoff = new Date(Date.now() - olderThanSec * 1000);
    const stale = await readRepo.listOpenPayments(cutoff);
    const summary: ReconcileSummary = {
      scanned: stale.length,
      captured: 0,
      failed: 0,
      stillPending: 0,
      other: 0,
    };
    for (const payment of stale) {
      const outcome = await reconcilePayment(payment);
      if (outcome === 'captured') summary.captured += 1;
      else if (outcome === 'failed') summary.failed += 1;
      else if (outcome === 'still_pending') summary.stillPending += 1;
      else summary.other += 1;
    }
    return summary;
  }

  async function reconciliationReport(): Promise<ReconciliationReport> {
    const open = await readRepo.listOpenPayments();
    const items: ReconciliationReportItem[] = [];
    for (const payment of open) {
      const remote = payment.checkoutRequestId
        ? await gateway.queryStkStatus(payment.checkoutRequestId)
        : { status: 'pending' as const, amountCents: null };
      let classification: ReportClassification;
      if (remote.status === 'success') {
        classification =
          remote.amountCents !== null && remote.amountCents !== payment.amountCents
            ? 'amount_mismatch'
            : 'remote_succeeded_local_open';
      } else if (remote.status === 'failed') {
        classification = 'remote_failed_local_open';
      } else {
        classification = 'pending';
      }
      items.push({
        paymentUlid: payment.ulid,
        localStatus: payment.status,
        remoteStatus: remote.status,
        amountCents: payment.amountCents,
        classification,
      });
    }
    const imbalanced = await ledgerReadRepo.findImbalancedTransactions();
    return {
      generatedAt: new Date().toISOString(),
      ledgerBalanced: imbalanced.length === 0,
      imbalancedTransactionCount: imbalanced.length,
      items,
    };
  }

  return { reconcilePayment, reconcileStalePayments, reconciliationReport };
}

export type ReconcileService = ReturnType<typeof createReconcileService>;
