import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../auth/repo';
import { createLedgerService } from '../ledger/ledger-service';
import type {
  AccountBalance,
  GetOrCreateAccountInput,
  InsertTransactionInput,
  LedgerAccount,
  LedgerRepo,
} from '../ledger/repo';
import { createPayoutService, type Actor } from './payout-service';
import type { PayoutGateway } from './gateway';
import type { ApprovedSettlementRow, PayoutRecord, PayoutsRepo, RiderEarningRow } from './repo';

class FakeLedgerRepo implements LedgerRepo {
  accounts = new Map<string, LedgerAccount>();
  txns: Array<{ id: number; ulid: string; idempotencyKey: string }> = [];
  entries: Array<{ direction: 'debit' | 'credit'; amountCents: number }> = [];
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
  insertEntry(input: { direction: 'debit' | 'credit'; amountCents: number }): Promise<void> {
    this.entries.push({ direction: input.direction, amountCents: input.amountCents });
    return Promise.resolve();
  }
  getAccountBalances(): Promise<AccountBalance[]> {
    return Promise.resolve([]);
  }
  findImbalancedTransactions(): Promise<number[]> {
    return Promise.resolve([]);
  }
}

function makeWorld(
  opts: { settlements?: ApprovedSettlementRow[]; earnings?: RiderEarningRow[] } = {},
) {
  const payouts: PayoutRecord[] = [];
  const lines: Array<{ payoutId: number; refType: string; refId: number }> = [];
  const settlementsPaid: number[] = [];
  const events = new Set<string>();
  const users = new Map<string, number>([
    ['FIN', 1],
    ['OPS', 2],
  ]);
  let seq = 0;

  const repo = {
    findUserIdByUlid: (ulid: string) => Promise.resolve(users.get(ulid) ?? null),
    listApprovedSettlementsForPeriod: () => Promise.resolve(opts.settlements ?? []),
    listRiderEarningsForPeriod: () => Promise.resolve(opts.earnings ?? []),
    findPayoutByIdempotencyKey: (key: string) =>
      Promise.resolve(payouts.find((p) => p.idempotencyKey === key) ?? null),
    insertPayout: (
      input: Omit<
        PayoutRecord,
        'id' | 'status' | 'externalRef' | 'financeApprovedBy' | 'opsApprovedBy'
      >,
    ) => {
      const id = ++seq;
      payouts.push({
        ...input,
        id,
        status: 'draft',
        externalRef: null,
        financeApprovedBy: null,
        opsApprovedBy: null,
      });
      return Promise.resolve(id);
    },
    insertPayoutLine: (input: { payoutId: number; refType: string; refId: number }) => {
      lines.push({ payoutId: input.payoutId, refType: input.refType, refId: input.refId });
      return Promise.resolve();
    },
    findPayoutByUlid: (ulid: string) =>
      Promise.resolve(payouts.find((p) => p.ulid === ulid) ?? null),
    lockPayoutByUlid: (ulid: string) =>
      Promise.resolve(payouts.find((p) => p.ulid === ulid) ?? null),
    lockPayoutByExternalRef: (ref: string) =>
      Promise.resolve(payouts.find((p) => p.externalRef === ref) ?? null),
    getPayeeMsisdn: () => Promise.resolve('+254700000123'),
    insertPayoutEventDedup: (input: { dedupeKey: string }) => {
      if (events.has(input.dedupeKey)) {
        return Promise.resolve(false);
      }
      events.add(input.dedupeKey);
      return Promise.resolve(true);
    },
    setFinanceApprover: (id: number, userId: number) => {
      payouts.find((p) => p.id === id)!.financeApprovedBy = userId;
      return Promise.resolve();
    },
    setOpsApprover: (id: number, userId: number) => {
      payouts.find((p) => p.id === id)!.opsApprovedBy = userId;
      return Promise.resolve();
    },
    setPayoutApproved: (id: number) => {
      payouts.find((p) => p.id === id)!.status = 'approved';
      return Promise.resolve();
    },
    setPayoutProcessing: (id: number, ref: string) => {
      const p = payouts.find((x) => x.id === id)!;
      p.status = 'processing';
      p.externalRef = ref;
      return Promise.resolve();
    },
    setPayoutPaid: (id: number) => {
      payouts.find((p) => p.id === id)!.status = 'paid';
      return Promise.resolve();
    },
    setPayoutFailed: (id: number) => {
      payouts.find((p) => p.id === id)!.status = 'failed';
      return Promise.resolve();
    },
    settlementRefsForPayout: (id: number) =>
      Promise.resolve(
        lines.filter((l) => l.payoutId === id && l.refType === 'settlement').map((l) => l.refId),
      ),
    markSettlementsPaid: (ids: number[]) => {
      settlementsPaid.push(...ids);
      return Promise.resolve();
    },
    listPayouts: () => Promise.resolve(payouts),
  } as unknown as PayoutsRepo;

  const ledger = new FakeLedgerRepo();
  const gateway: PayoutGateway = {
    initiateB2c: () => Promise.resolve({ externalRef: 'SIMB2C-REF' }),
  };
  const audits: Partial<AuditEntry>[] = [];
  const svc = createPayoutService({
    withTransaction: (work) => work({ payouts: repo, ledger }),
    ledgerService: createLedgerService(),
    gateway,
    auditService: {
      record: (e: Partial<AuditEntry> & Pick<AuditEntry, 'action' | 'entityType'>) => {
        audits.push(e);
        return Promise.resolve();
      },
      listRecent: () => Promise.resolve([]),
    },
  });
  return { svc, payouts, ledger, settlementsPaid };
}

const FIN: Actor = { ulid: 'FIN', roles: ['finance'] };
const OPS: Actor = { ulid: 'OPS', roles: ['ops'] };
const period = { periodStart: '2026-10-01', periodEnd: '2026-10-07' };

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

describe('payout service — generation', () => {
  it('drafts a merchant payout per approved settlement and a rider payout per rider', async () => {
    const w = makeWorld({
      settlements: [{ settlementId: 1, merchantId: 10, netCents: 40_000 }],
      earnings: [
        { riderId: 9, deliveryId: 1, riderFeeCents: 7_000 },
        { riderId: 9, deliveryId: 2, riderFeeCents: 7_000 },
      ],
    });
    const res = await w.svc.generatePayouts(FIN, period);
    expect(res.generated).toBe(2);
    expect(w.payouts.find((p) => p.payeeType === 'merchant')?.amountCents).toBe(40_000);
    expect(w.payouts.find((p) => p.payeeType === 'rider')?.amountCents).toBe(14_000);
  });

  it('is idempotent and skips zero-amount payees', async () => {
    const w = makeWorld({ settlements: [{ settlementId: 1, merchantId: 10, netCents: 0 }] });
    const first = await w.svc.generatePayouts(FIN, period);
    expect(first.generated).toBe(0); // zero-amount settlement skipped
    const w2 = makeWorld({ settlements: [{ settlementId: 1, merchantId: 10, netCents: 40_000 }] });
    await w2.svc.generatePayouts(FIN, period);
    const again = await w2.svc.generatePayouts(FIN, period);
    expect(again.generated).toBe(0);
    expect(again.skipped).toBe(1);
  });
});

describe('payout service — dual-sign + execute + confirm', () => {
  async function drafted() {
    const w = makeWorld({ settlements: [{ settlementId: 1, merchantId: 10, netCents: 40_000 }] });
    const { payouts } = await w.svc.generatePayouts(FIN, period);
    return { w, ulid: payouts[0]!.ulid };
  }

  it('requires BOTH a finance and an ops approval before execute', async () => {
    const { w, ulid } = await drafted();
    expect((await w.svc.approveFinance(FIN, ulid)).status).toBe('draft'); // one approval only
    expect(await thrownStatus(w.svc.executePayout(FIN, ulid))).toBe(409); // not approved yet
    expect((await w.svc.approveOps(OPS, ulid)).status).toBe('approved');
    expect((await w.svc.executePayout(FIN, ulid)).status).toBe('processing');
  });

  it('forbids the same user filling both approval slots (separation of duties)', async () => {
    const { w, ulid } = await drafted();
    await w.svc.approveFinance(FIN, ulid);
    expect(await thrownStatus(w.svc.approveOps(FIN, ulid))).toBe(403);
  });

  it('rejects a second approval on the same side (409)', async () => {
    const { w, ulid } = await drafted();
    await w.svc.approveFinance(FIN, ulid);
    expect(await thrownStatus(w.svc.approveFinance(FIN, ulid))).toBe(409);
  });

  it('confirm success posts a balanced payout ledger txn, marks paid + settlement paid; replay no-ops', async () => {
    const { w, ulid } = await drafted();
    await w.svc.approveFinance(FIN, ulid);
    await w.svc.approveOps(OPS, ulid);
    await w.svc.executePayout(FIN, ulid);

    expect(await w.svc.confirmPayout(ulid, true)).toBe('paid');
    expect(w.payouts[0]?.status).toBe('paid');
    expect(w.settlementsPaid).toEqual([1]);
    expect(w.ledger.txns).toHaveLength(1);
    const debit = w.ledger.entries
      .filter((e) => e.direction === 'debit')
      .reduce((s, e) => s + e.amountCents, 0);
    const credit = w.ledger.entries
      .filter((e) => e.direction === 'credit')
      .reduce((s, e) => s + e.amountCents, 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(40_000);

    expect(await w.svc.confirmPayout(ulid, true)).toBe('already_final');
    expect(w.ledger.txns).toHaveLength(1); // not posted twice
  });

  it('confirm failure marks the payout failed and posts nothing', async () => {
    const { w, ulid } = await drafted();
    await w.svc.approveFinance(FIN, ulid);
    await w.svc.approveOps(OPS, ulid);
    await w.svc.executePayout(FIN, ulid);
    expect(await w.svc.confirmPayout(ulid, false)).toBe('failed');
    expect(w.payouts[0]?.status).toBe('failed');
    expect(w.ledger.txns).toHaveLength(0);
  });
});

describe('payout service — B2C result callback (applyB2cResult)', () => {
  async function processing() {
    const w = makeWorld({ settlements: [{ settlementId: 1, merchantId: 10, netCents: 40_000 }] });
    const { payouts } = await w.svc.generatePayouts(FIN, period);
    const ulid = payouts[0]!.ulid;
    await w.svc.approveFinance(FIN, ulid);
    await w.svc.approveOps(OPS, ulid);
    await w.svc.executePayout(FIN, ulid); // externalRef = 'SIMB2C-REF'
    return { w, ulid, conversationId: 'SIMB2C-REF' };
  }

  it('confirms the matching payout on a success result; a replay is de-duplicated', async () => {
    const { w, conversationId } = await processing();
    expect(await w.svc.applyB2cResult({ conversationId, resultCode: 0, rawPayload: {} })).toBe(
      'paid',
    );
    expect(w.payouts[0]?.status).toBe('paid');
    expect(w.settlementsPaid).toEqual([1]);
    expect(w.ledger.txns).toHaveLength(1);

    // Same conversation + result replayed → deduped, no second posting.
    expect(await w.svc.applyB2cResult({ conversationId, resultCode: 0, rawPayload: {} })).toBe(
      'duplicate',
    );
    expect(w.ledger.txns).toHaveLength(1);
  });

  it('marks the payout failed on a non-zero result code', async () => {
    const { w, conversationId } = await processing();
    expect(await w.svc.applyB2cResult({ conversationId, resultCode: 1, rawPayload: {} })).toBe(
      'failed',
    );
    expect(w.payouts[0]?.status).toBe('failed');
    expect(w.ledger.txns).toHaveLength(0);
  });

  it('records but does not act on an unknown conversation id', async () => {
    const { w } = await processing();
    expect(
      await w.svc.applyB2cResult({ conversationId: 'NOPE', resultCode: 0, rawPayload: {} }),
    ).toBe('unknown');
    expect(w.payouts[0]?.status).toBe('processing');
  });
});
