import { describe, expect, it } from 'vitest';
import { merchantPayableCode } from './accounts';
import { createLedgerService, type PostInput, type PostingLine } from './ledger-service';
import type {
  AccountBalance,
  GetOrCreateAccountInput,
  InsertTransactionInput,
  LedgerAccount,
  LedgerRepo,
} from './repo';

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
    const byId = new Map<number, LedgerAccount>();
    for (const a of this.accounts.values()) byId.set(a.id, a);
    const res = new Map<string, AccountBalance>();
    for (const a of this.accounts.values()) {
      res.set(a.code, { code: a.code, type: a.type, debitCents: 0, creditCents: 0 });
    }
    for (const e of this.entries) {
      const code = byId.get(e.accountId)!.code;
      const r = res.get(code)!;
      if (e.direction === 'debit') r.debitCents += e.amountCents;
      else r.creditCents += e.amountCents;
    }
    return Promise.resolve([...res.values()]);
  }
}

/** A platform-funded (D4) capture posting for an order. */
function captureLines(args: {
  subtotal: number;
  delivery: number;
  service: number;
  discount: number;
  commission: number;
  merchantId: number;
}): PostingLine[] {
  const total = args.subtotal + args.delivery + args.service - args.discount;
  const lines: PostingLine[] = [
    { accountCode: 'mpesa_clearing', accountType: 'asset', direction: 'debit', amountCents: total },
    {
      accountCode: merchantPayableCode(args.merchantId),
      accountType: 'liability',
      ownerType: 'merchant',
      ownerId: args.merchantId,
      direction: 'credit',
      amountCents: args.subtotal - args.commission,
    },
    {
      accountCode: 'commission_revenue',
      accountType: 'revenue',
      direction: 'credit',
      amountCents: args.commission,
    },
    {
      accountCode: 'platform_delivery_income',
      accountType: 'revenue',
      direction: 'credit',
      amountCents: args.delivery,
    },
  ];
  if (args.service > 0) {
    lines.push({
      accountCode: 'platform_service_income',
      accountType: 'revenue',
      direction: 'credit',
      amountCents: args.service,
    });
  }
  if (args.discount > 0) {
    lines.push({
      accountCode: 'promo_expense',
      accountType: 'expense',
      direction: 'debit',
      amountCents: args.discount,
    });
  }
  return lines;
}

function capture(idempotencyKey: string, lines: PostingLine[]): PostInput {
  return { kind: 'order_capture', refType: 'payment', refId: 1, idempotencyKey, lines };
}

describe('ledger service — post', () => {
  it('posts a balanced capture, creating accounts and entries', async () => {
    const repo = new FakeLedgerRepo();
    const svc = createLedgerService();
    const lines = captureLines({
      subtotal: 30_200,
      delivery: 10_000,
      service: 0,
      discount: 3_020,
      commission: 3_020,
      merchantId: 5,
    });
    const res = await svc.post(repo, capture('order_capture:1', lines));
    expect(res.created).toBe(true);
    expect(repo.txns).toHaveLength(1);

    const balances = await repo.getAccountBalances();
    const byCode = new Map(balances.map((b) => [b.code, b]));
    expect(byCode.get('mpesa_clearing')?.debitCents).toBe(37_180); // total = 30200 + 10000 - 3020
    expect(byCode.get('promo_expense')?.debitCents).toBe(3_020);
    expect(byCode.get(merchantPayableCode(5))?.creditCents).toBe(27_180); // subtotal - commission
    expect(byCode.get('commission_revenue')?.creditCents).toBe(3_020);
    expect(byCode.get('platform_delivery_income')?.creditCents).toBe(10_000);

    const totalDebit = balances.reduce((s, b) => s + b.debitCents, 0);
    const totalCredit = balances.reduce((s, b) => s + b.creditCents, 0);
    expect(totalDebit).toBe(totalCredit); // ledger balances
  });

  it('is idempotent on the idempotency key (no second transaction)', async () => {
    const repo = new FakeLedgerRepo();
    const svc = createLedgerService();
    const lines = captureLines({
      subtotal: 10_000,
      delivery: 10_000,
      service: 0,
      discount: 0,
      commission: 1_000,
      merchantId: 1,
    });
    const first = await svc.post(repo, capture('order_capture:9', lines));
    const second = await svc.post(repo, capture('order_capture:9', lines));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.ulid).toBe(first.ulid);
    expect(repo.txns).toHaveLength(1);
    expect(repo.entries).toHaveLength(4); // only the first posting wrote entries
  });

  it('rejects an unbalanced transaction and writes nothing', async () => {
    const repo = new FakeLedgerRepo();
    const svc = createLedgerService();
    await expect(
      svc.post(repo, {
        kind: 'order_capture',
        refType: 'payment',
        refId: 1,
        idempotencyKey: 'bad',
        lines: [
          {
            accountCode: 'mpesa_clearing',
            accountType: 'asset',
            direction: 'debit',
            amountCents: 100,
          },
          {
            accountCode: 'commission_revenue',
            accountType: 'revenue',
            direction: 'credit',
            amountCents: 90,
          },
        ],
      }),
    ).rejects.toThrow(/LEDGER_UNBALANCED/);
    expect(repo.txns).toHaveLength(0);
    expect(repo.entries).toHaveLength(0);
  });

  it('rejects fewer than two entries and non-positive amounts', async () => {
    const repo = new FakeLedgerRepo();
    const svc = createLedgerService();
    await expect(
      svc.post(repo, {
        kind: 'x',
        refType: 'payment',
        refId: 1,
        idempotencyKey: 'one',
        lines: [
          {
            accountCode: 'mpesa_clearing',
            accountType: 'asset',
            direction: 'debit',
            amountCents: 100,
          },
        ],
      }),
    ).rejects.toThrow(/LEDGER_INVALID/);
    await expect(
      svc.post(repo, {
        kind: 'x',
        refType: 'payment',
        refId: 1,
        idempotencyKey: 'zero',
        lines: [
          {
            accountCode: 'mpesa_clearing',
            accountType: 'asset',
            direction: 'debit',
            amountCents: 0,
          },
          {
            accountCode: 'commission_revenue',
            accountType: 'revenue',
            direction: 'credit',
            amountCents: 0,
          },
        ],
      }),
    ).rejects.toThrow(/LEDGER_INVALID/);
  });
});
