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
import { SimulatedGateway } from './simulated-gateway';
import { createRefundService, type Actor } from './refund-service';
import type { RefundRecord } from './refund';
import type { InsertRefundInput, OrderPaymentStatus, PaymentRecord, PaymentsRepo } from './repo';

class FakeLedgerRepo implements LedgerRepo {
  accounts = new Map<string, LedgerAccount>();
  txns: Array<{ id: number; ulid: string; idempotencyKey: string }> = [];
  entries: Array<{ accountId: number; direction: 'debit' | 'credit'; amountCents: number }> = [];
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
    this.entries.push({
      accountId: input.accountId,
      direction: input.direction,
      amountCents: input.amountCents,
    });
    return Promise.resolve();
  }
  getAccountBalances(): Promise<AccountBalance[]> {
    return Promise.resolve([]);
  }
  findImbalancedTransactions(): Promise<number[]> {
    return Promise.resolve([]);
  }
  /** Sum of all debits minus all credits across every entry (0 ⇒ the postings balance). */
  net(): number {
    return this.entries.reduce(
      (s, e) => s + (e.direction === 'debit' ? e.amountCents : -e.amountCents),
      0,
    );
  }
}

const SNAPSHOT = {
  id: 10,
  merchantId: 5,
  status: 'placed' as OrderStatus,
  subtotalCents: 30_200,
  deliveryFeeCents: 10_000,
  serviceFeeCents: 0,
  discountCents: 3_020,
  totalCents: 37_180,
  commissionCents: 3_020,
};

function makeRepo(
  overrides: Partial<{ status: OrderStatus; paymentStatus: OrderPaymentStatus }> = {},
) {
  const order = {
    id: 10,
    ulid: 'ORD1',
    status: overrides.status ?? ('placed' as OrderStatus),
    paymentStatus: overrides.paymentStatus ?? ('paid' as OrderPaymentStatus),
    totalCents: 37_180,
    customerId: 7,
  };
  const payment: PaymentRecord = {
    id: 1,
    ulid: 'PAY1',
    orderId: 10,
    method: 'simulated',
    amountCents: 37_180,
    currency: 'KES',
    status: 'succeeded',
    checkoutRequestId: 'SIM-1',
    merchantRequestId: 'SIMMR-1',
    mpesaReceipt: 'RCPT1',
    idempotencyKey: 'pk1',
  };
  const users = new Map<string, number>([
    ['requester', 20],
    ['approver', 21],
  ]);
  const idToUlid = new Map<number, string>([
    [20, 'requester'],
    [21, 'approver'],
  ]);
  const refunds: RefundRecord[] = [];
  const history: Array<{ fromStatus: OrderStatus; toStatus: OrderStatus }> = [];
  let seqR = 0;

  const repo = {
    findUserIdByUlid: (ulid: string) => Promise.resolve(users.get(ulid) ?? null),
    findUserUlidById: (id: number) => Promise.resolve(idToUlid.get(id) ?? null),
    findOrderForRefund: (ulid: string) =>
      Promise.resolve(ulid === order.ulid ? { ...order } : null),
    findOrderUlidForPayment: (paymentId: number) =>
      Promise.resolve(
        paymentId === payment.id ? { orderUlid: order.ulid, customerId: order.customerId } : null,
      ),
    findSucceededPaymentByOrderId: () => Promise.resolve(payment),
    sumCompletedRefunds: () =>
      Promise.resolve(
        refunds.filter((r) => r.status === 'completed').reduce((s, r) => s + r.amountCents, 0),
      ),
    getOrderMoneySnapshot: () => Promise.resolve({ ...SNAPSHOT, status: order.status }),
    insertRefund: (input: InsertRefundInput) => {
      const id = ++seqR;
      refunds.push({ ...input, id, approvedBy: null, providerRef: null });
      return Promise.resolve(id);
    },
    findRefundByUlid: (ulid: string) =>
      Promise.resolve(refunds.find((r) => r.ulid === ulid) ?? null),
    lockRefundByUlid: (ulid: string) =>
      Promise.resolve(refunds.find((r) => r.ulid === ulid) ?? null),
    findRefundByIdempotencyKey: (key: string) =>
      Promise.resolve(refunds.find((r) => r.idempotencyKey === key) ?? null),
    markRefundProcessing: (id: number, approvedBy: number, providerRef: string) => {
      const r = refunds.find((x) => x.id === id)!;
      r.status = 'processing';
      r.approvedBy = approvedBy;
      r.providerRef = providerRef;
      return Promise.resolve();
    },
    markRefundRejected: (id: number, approvedBy: number) => {
      const r = refunds.find((x) => x.id === id)!;
      r.status = 'rejected';
      r.approvedBy = approvedBy;
      return Promise.resolve();
    },
    markRefundCompleted: (id: number) => {
      refunds.find((x) => x.id === id)!.status = 'completed';
      return Promise.resolve();
    },
    markRefundFailed: (id: number) => {
      refunds.find((x) => x.id === id)!.status = 'failed';
      return Promise.resolve();
    },
    setOrderStatusAndPayment: (_id: number, status: OrderStatus, ps: OrderPaymentStatus) => {
      order.status = status;
      order.paymentStatus = ps;
      return Promise.resolve();
    },
    setOrderPaymentStatus: (_id: number, ps: OrderPaymentStatus) => {
      order.paymentStatus = ps;
      return Promise.resolve();
    },
    insertStatusHistory: (input: { fromStatus: OrderStatus; toStatus: OrderStatus }) => {
      history.push({ fromStatus: input.fromStatus, toStatus: input.toStatus });
      return Promise.resolve();
    },
  };

  return { repo: repo as unknown as PaymentsRepo, order, refunds, history };
}

function makeSvc(repo: PaymentsRepo) {
  const ledger = new FakeLedgerRepo();
  const svc = createRefundService({
    readRepo: repo,
    withTransaction: (work) => work({ payments: repo, ledger }),
    ledgerService: createLedgerService(),
    gateway: new SimulatedGateway(),
  });
  return { svc, ledger };
}

const REQUESTER: Actor = { ulid: 'requester', roles: ['ops'] };
const APPROVER: Actor = { ulid: 'approver', roles: ['finance'] };

describe('refund service — request', () => {
  it('records a requested refund against a paid order', async () => {
    const { repo, refunds } = makeRepo();
    const { svc } = makeSvc(repo);
    const view = await svc.requestRefund(REQUESTER, 'ORD1', {
      amountCents: 37_180,
      reason: 'dispute',
      idempotencyKey: 'r1',
    });
    expect(view.status).toBe('requested');
    expect(view.orderUlid).toBe('ORD1');
    expect(refunds).toHaveLength(1);
  });

  it('rejects an amount above the net refundable total (400)', async () => {
    const { repo } = makeRepo();
    const { svc } = makeSvc(repo);
    await expect(
      svc.requestRefund(REQUESTER, 'ORD1', {
        amountCents: 50_000,
        reason: 'too much',
        idempotencyKey: 'r1',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a refund on an unpaid order (409)', async () => {
    const { repo } = makeRepo({ paymentStatus: 'unpaid' });
    const { svc } = makeSvc(repo);
    await expect(
      svc.requestRefund(REQUESTER, 'ORD1', { amountCents: 100, reason: 'x', idempotencyKey: 'r1' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('is idempotent on the Idempotency-Key', async () => {
    const { repo, refunds } = makeRepo();
    const { svc } = makeSvc(repo);
    const a = await svc.requestRefund(REQUESTER, 'ORD1', {
      amountCents: 100,
      reason: 'x',
      idempotencyKey: 'same',
    });
    const b = await svc.requestRefund(REQUESTER, 'ORD1', {
      amountCents: 100,
      reason: 'x',
      idempotencyKey: 'same',
    });
    expect(b.ulid).toBe(a.ulid);
    expect(refunds).toHaveLength(1);
  });
});

describe('refund service — approve (separation of duties)', () => {
  it('forbids the requester approving their own refund (403)', async () => {
    const { repo } = makeRepo();
    const { svc } = makeSvc(repo);
    const r = await svc.requestRefund(REQUESTER, 'ORD1', {
      amountCents: 100,
      reason: 'x',
      idempotencyKey: 'r1',
    });
    await expect(svc.approveRefund(REQUESTER, r.ulid)).rejects.toMatchObject({ status: 403 });
  });

  it('a different approver moves the refund to processing with a provider ref', async () => {
    const { repo, refunds } = makeRepo();
    const { svc } = makeSvc(repo);
    const r = await svc.requestRefund(REQUESTER, 'ORD1', {
      amountCents: 100,
      reason: 'x',
      idempotencyKey: 'r1',
    });
    const view = await svc.approveRefund(APPROVER, r.ulid);
    expect(view.status).toBe('processing');
    expect(refunds[0]?.providerRef).toMatch(/^SIMREV-/);
    expect(refunds[0]?.approvedBy).toBe(21);
  });
});

describe('refund service — execute (ledger reversal)', () => {
  it('completes a full refund: balanced reversal + order payment_status refunded', async () => {
    const { repo, order } = makeRepo();
    const { svc, ledger } = makeSvc(repo);
    const r = await svc.requestRefund(REQUESTER, 'ORD1', {
      amountCents: 37_180,
      reason: 'full',
      idempotencyKey: 'r1',
    });
    await svc.approveRefund(APPROVER, r.ulid);
    expect(await svc.processReversalResult(r.ulid, true)).toBe('completed');
    expect(ledger.net()).toBe(0); // debits == credits
    expect(ledger.txns).toHaveLength(1);
    expect(order.paymentStatus).toBe('refunded');
  });

  it('a partial refund is merchant-borne and leaves the order partially_refunded', async () => {
    const { repo, order } = makeRepo();
    const { svc, ledger } = makeSvc(repo);
    const r = await svc.requestRefund(REQUESTER, 'ORD1', {
      amountCents: 5_000,
      reason: 'partial',
      idempotencyKey: 'r1',
    });
    await svc.approveRefund(APPROVER, r.ulid);
    expect(await svc.processReversalResult(r.ulid, true)).toBe('completed');
    expect(ledger.net()).toBe(0);
    // Merchant bears it: exactly two entries (DR merchant_payable / CR refunds_payable).
    expect(ledger.entries).toHaveLength(2);
    expect(order.paymentStatus).toBe('partially_refunded');
  });

  it('is idempotent: replaying a completed reversal never double-posts', async () => {
    const { repo } = makeRepo();
    const { svc, ledger } = makeSvc(repo);
    const r = await svc.requestRefund(REQUESTER, 'ORD1', {
      amountCents: 5_000,
      reason: 'x',
      idempotencyKey: 'r1',
    });
    await svc.approveRefund(APPROVER, r.ulid);
    await svc.processReversalResult(r.ulid, true);
    expect(await svc.processReversalResult(r.ulid, true)).toBe('already_final');
    expect(ledger.txns).toHaveLength(1); // not posted twice
  });

  it('a failed reversal marks the refund failed and posts nothing', async () => {
    const { repo, order } = makeRepo();
    const { svc, ledger } = makeSvc(repo);
    const r = await svc.requestRefund(REQUESTER, 'ORD1', {
      amountCents: 100,
      reason: 'x',
      idempotencyKey: 'r1',
    });
    await svc.approveRefund(APPROVER, r.ulid);
    expect(await svc.processReversalResult(r.ulid, false)).toBe('failed');
    expect(ledger.txns).toHaveLength(0);
    expect(order.paymentStatus).toBe('paid'); // untouched
  });
});

describe('refund service — reject', () => {
  it('rejects a requested refund without moving money', async () => {
    const { repo } = makeRepo();
    const { svc, ledger } = makeSvc(repo);
    const r = await svc.requestRefund(REQUESTER, 'ORD1', {
      amountCents: 100,
      reason: 'x',
      idempotencyKey: 'r1',
    });
    const view = await svc.rejectRefund(APPROVER, r.ulid);
    expect(view.status).toBe('rejected');
    expect(ledger.txns).toHaveLength(0);
  });
});
