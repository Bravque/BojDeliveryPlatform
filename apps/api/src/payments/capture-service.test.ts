import { describe, expect, it } from 'vitest';
import { createLedgerService } from '../ledger/ledger-service';
import type {
  AccountBalance,
  GetOrCreateAccountInput,
  InsertTransactionInput,
  LedgerAccount,
  LedgerRepo,
} from '../ledger/repo';
import type { OrderStatus } from '../orders/state-machine';
import { createCaptureService, type CaptureRepos } from './capture-service';
import type { StkCallback } from './capture';
import type { PaymentRecord, PaymentsRepo } from './repo';

class FakeLedgerRepo implements LedgerRepo {
  accounts = new Map<string, LedgerAccount>();
  txns: Array<{ id: number; ulid: string; idempotencyKey: string }> = [];
  entries: Array<{
    transactionId: number;
    accountId: number;
    direction: 'debit' | 'credit';
    amountCents: number;
  }> = [];
  private seqA = 0;
  private seqT = 0;
  getOrCreateAccount(input: GetOrCreateAccountInput): Promise<LedgerAccount> {
    let a = this.accounts.get(input.code);
    if (!a) {
      a = { id: ++this.seqA, code: input.code, type: input.type };
      this.accounts.set(input.code, a);
    }
    return Promise.resolve(a);
  }
  findTransactionByIdempotencyKey(key: string): Promise<{ id: number; ulid: string } | null> {
    const t = this.txns.find((x) => x.idempotencyKey === key);
    return Promise.resolve(t ? { id: t.id, ulid: t.ulid } : null);
  }
  insertTransaction(input: InsertTransactionInput): Promise<number> {
    const id = ++this.seqT;
    this.txns.push({ id, ulid: input.ulid, idempotencyKey: input.idempotencyKey });
    return Promise.resolve(id);
  }
  insertEntry(input: {
    transactionId: number;
    accountId: number;
    direction: 'debit' | 'credit';
    amountCents: number;
  }): Promise<void> {
    this.entries.push(input);
    return Promise.resolve();
  }
  getAccountBalances(): Promise<AccountBalance[]> {
    return Promise.resolve([]);
  }
}

class FakeCapturePaymentsRepo implements PaymentsRepo {
  payment: PaymentRecord = {
    id: 1,
    ulid: 'PAY1',
    orderId: 10,
    method: 'simulated',
    amountCents: 37_180,
    currency: 'KES',
    status: 'pending',
    checkoutRequestId: 'SIM-1',
    merchantRequestId: 'SIMMR-1',
    mpesaReceipt: null,
    idempotencyKey: 'k1',
  };
  snapshot = {
    id: 10,
    merchantId: 5,
    status: 'payment_pending' as OrderStatus,
    subtotalCents: 30_200,
    deliveryFeeCents: 10_000,
    serviceFeeCents: 0,
    discountCents: 3_020,
    totalCents: 37_180,
    commissionCents: 3_020,
  };
  dedupeKeys = new Set<string>();
  stock = [{ productId: 100, quantity: 2, reserved: 2 }];
  history: Array<{ fromStatus: OrderStatus; toStatus: OrderStatus }> = [];
  paymentStatus: string | null = null;

  findPaymentByCheckoutRequestId(cri: string): Promise<PaymentRecord | null> {
    return Promise.resolve(this.payment.checkoutRequestId === cri ? this.payment : null);
  }
  insertPaymentEventDedup(input: { dedupeKey: string }): Promise<boolean> {
    if (this.dedupeKeys.has(input.dedupeKey)) return Promise.resolve(false);
    this.dedupeKeys.add(input.dedupeKey);
    return Promise.resolve(true);
  }
  markPaymentSucceeded(_id: number, receipt: string | null): Promise<void> {
    this.payment.status = 'succeeded';
    this.payment.mpesaReceipt = receipt;
    return Promise.resolve();
  }
  markPaymentFailed(_id: number, status: 'failed' | 'timed_out'): Promise<void> {
    this.payment.status = status;
    return Promise.resolve();
  }
  getOrderMoneySnapshot(): Promise<typeof this.snapshot | null> {
    return Promise.resolve(this.snapshot);
  }
  setOrderStatusAndPayment(
    _orderId: number,
    status: OrderStatus,
    paymentStatus: 'paid' | 'failed',
  ): Promise<void> {
    this.snapshot.status = status;
    this.paymentStatus = paymentStatus;
    return Promise.resolve();
  }
  listOrderStockLines(): Promise<Array<{ productId: number; quantity: number }>> {
    return Promise.resolve(
      this.stock.map((s) => ({ productId: s.productId, quantity: s.quantity })),
    );
  }
  releaseStock(productId: number, quantity: number): Promise<void> {
    const s = this.stock.find((x) => x.productId === productId);
    if (s) s.reserved = Math.max(0, s.reserved - quantity);
    return Promise.resolve();
  }
  insertStatusHistory(input: { fromStatus: OrderStatus; toStatus: OrderStatus }): Promise<void> {
    this.history.push({ fromStatus: input.fromStatus, toStatus: input.toStatus });
    return Promise.resolve();
  }
  findPaymentByUlid(ulid: string): Promise<PaymentRecord | null> {
    return Promise.resolve(this.payment.ulid === ulid ? this.payment : null);
  }
  // Initiation-path methods unused here.
  async findUserIdByUlid() {
    return null;
  }
  async findOrderForPayment() {
    return null;
  }
  async findPaymentByIdempotencyKey() {
    return null;
  }
  async findOrderUlidForPayment() {
    return null;
  }
  async insertPayment() {
    return 1;
  }
  async markPending() {}
  async setOrderStatus() {}
}

function makeSvc() {
  const repo = new FakeCapturePaymentsRepo();
  const ledger = new FakeLedgerRepo();
  const repos: CaptureRepos = { payments: repo, ledger };
  const svc = createCaptureService({
    readRepo: repo,
    withTransaction: (work) => work(repos),
    ledgerService: createLedgerService(),
  });
  return { repo, ledger, svc };
}

const success: StkCallback = {
  checkoutRequestId: 'SIM-1',
  resultCode: 0,
  resultDesc: 'ok',
  amountCents: 37_180,
  mpesaReceipt: 'RCPT1',
};
const failure: StkCallback = {
  checkoutRequestId: 'SIM-1',
  resultCode: 1032,
  resultDesc: 'cancelled',
  amountCents: null,
  mpesaReceipt: null,
};

describe('capture service — processStkResult', () => {
  it('captures a verified success: payment succeeded, order placed+paid, ledger posted, history', async () => {
    const { repo, ledger, svc } = makeSvc();
    expect(await svc.processStkResult(success)).toBe('captured');
    expect(repo.payment.status).toBe('succeeded');
    expect(repo.payment.mpesaReceipt).toBe('RCPT1');
    expect(repo.snapshot.status).toBe('placed');
    expect(repo.paymentStatus).toBe('paid');
    expect(ledger.txns).toHaveLength(1);
    const debit = ledger.entries
      .filter((e) => e.direction === 'debit')
      .reduce((s, e) => s + e.amountCents, 0);
    const credit = ledger.entries
      .filter((e) => e.direction === 'credit')
      .reduce((s, e) => s + e.amountCents, 0);
    expect(debit).toBe(credit); // balanced capture
    expect(repo.history.at(-1)).toMatchObject({
      fromStatus: 'payment_pending',
      toStatus: 'placed',
    });
  });

  it('is idempotent: a duplicate callback does not capture twice', async () => {
    const { ledger, svc } = makeSvc();
    expect(await svc.processStkResult(success)).toBe('captured');
    expect(await svc.processStkResult(success)).toBe('duplicate');
    expect(ledger.txns).toHaveLength(1); // exactly one capture
  });

  it('quarantines an amount mismatch (no capture)', async () => {
    const { repo, ledger, svc } = makeSvc();
    expect(await svc.processStkResult({ ...success, amountCents: 999 })).toBe('amount_mismatch');
    expect(repo.payment.status).toBe('pending'); // untouched
    expect(repo.snapshot.status).toBe('payment_pending');
    expect(ledger.txns).toHaveLength(0);
  });

  it('fails a declined payment: order payment_failed, stock released', async () => {
    const { repo, svc } = makeSvc();
    expect(await svc.processStkResult(failure)).toBe('failed');
    expect(repo.payment.status).toBe('failed');
    expect(repo.snapshot.status).toBe('payment_failed');
    expect(repo.paymentStatus).toBe('failed');
    expect(repo.stock[0]?.reserved).toBe(0); // released
  });

  it('returns unknown_payment for an unrecognised checkout id', async () => {
    const { svc } = makeSvc();
    expect(await svc.processStkResult({ ...success, checkoutRequestId: 'SIM-OTHER' })).toBe(
      'unknown_payment',
    );
  });

  it('does not reprocess a payment already in a final state', async () => {
    const { svc } = makeSvc();
    expect(await svc.processStkResult(success)).toBe('captured');
    // A fresh event (different result code) on an already-succeeded payment is a no-op.
    expect(await svc.processStkResult(failure)).toBe('already_final');
  });
});

describe('capture service — simulate', () => {
  it('drives a success capture for a payment ulid', async () => {
    const { repo, svc } = makeSvc();
    expect(await svc.simulate('PAY1', 'success')).toBe('captured');
    expect(repo.payment.status).toBe('succeeded');
  });

  it('forces an amount mismatch when overridden', async () => {
    const { svc } = makeSvc();
    expect(await svc.simulate('PAY1', 'success', 999)).toBe('amount_mismatch');
  });
});
