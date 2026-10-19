import type { Knex } from 'knex';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { merchantPayableCode } from '../ledger/accounts';
import { createLedgerService, type PostingLine } from '../ledger/ledger-service';
import { createKnexLedgerRepo } from '../ledger/repo';
import { buildKnexConfig, createDb } from '../platform/db';

/** Double-entry ledger end-to-end against a real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;

/** Platform-funded (D4) capture posting. */
function captureLines(): PostingLine[] {
  // subtotal 30200, delivery 10000, service 0, discount 3020, commission 3020 → total 37180
  return [
    {
      accountCode: 'mpesa_clearing',
      accountType: 'asset',
      direction: 'debit',
      amountCents: 37_180,
    },
    {
      accountCode: 'promo_expense',
      accountType: 'expense',
      direction: 'debit',
      amountCents: 3_020,
    },
    {
      accountCode: merchantPayableCode(5),
      accountType: 'liability',
      ownerType: 'merchant',
      ownerId: 5,
      direction: 'credit',
      amountCents: 27_180,
    },
    {
      accountCode: 'commission_revenue',
      accountType: 'revenue',
      direction: 'credit',
      amountCents: 3_020,
    },
    {
      accountCode: 'platform_delivery_income',
      accountType: 'revenue',
      direction: 'credit',
      amountCents: 10_000,
    },
  ];
}

describe.skipIf(!DATABASE_URL)('ledger integration (real MySQL)', () => {
  let db: Knex;
  const svc = createLedgerService();

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of ['ledger_entry', 'ledger_transaction', 'ledger_account']) {
      await db(table).truncate();
    }
    await db.raw('SET FOREIGN_KEY_CHECKS = 1');
  });

  it('posts a balanced capture inside a transaction and persists balanced entries', async () => {
    await db.transaction((trx) =>
      svc.post(createKnexLedgerRepo(trx), {
        kind: 'order_capture',
        refType: 'payment',
        refId: 1,
        idempotencyKey: 'order_capture:1',
        lines: captureLines(),
      }),
    );

    expect(await db('ledger_transaction')).toHaveLength(1);
    expect(await db('ledger_entry')).toHaveLength(5);

    const balances = await createKnexLedgerRepo(db).getAccountBalances();
    const totalDebit = balances.reduce((s, b) => s + b.debitCents, 0);
    const totalCredit = balances.reduce((s, b) => s + b.creditCents, 0);
    expect(totalDebit).toBe(totalCredit); // ledger balances
    expect(totalDebit).toBe(40_200); // 37180 + 3020 debits

    // Per-merchant payable account was created on demand.
    const acct = (await db('ledger_account')
      .where({ code: merchantPayableCode(5) })
      .first('owner_type', 'owner_id')) as { owner_type: string; owner_id: number };
    expect(acct.owner_type).toBe('merchant');
    expect(Number(acct.owner_id)).toBe(5);
  });

  it('is idempotent: replaying the same key yields exactly one transaction', async () => {
    const repo = createKnexLedgerRepo(db);
    const input = {
      kind: 'order_capture',
      refType: 'payment',
      refId: 2,
      idempotencyKey: 'order_capture:2',
      lines: captureLines(),
    };
    const first = await svc.post(repo, input);
    const second = await svc.post(repo, input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await db('ledger_transaction')).toHaveLength(1);
    expect(await db('ledger_entry')).toHaveLength(5);
  });

  it('rejects an unbalanced transaction and writes nothing', async () => {
    const repo = createKnexLedgerRepo(db);
    await expect(
      svc.post(repo, {
        kind: 'order_capture',
        refType: 'payment',
        refId: 3,
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
    expect(await db('ledger_transaction')).toHaveLength(0);
    expect(await db('ledger_entry')).toHaveLength(0);
  });

  it('enforces the positive-amount CHECK constraint at the database', async () => {
    const [accountId] = await db('ledger_account').insert({
      code: 'mpesa_clearing',
      type: 'asset',
      owner_type: 'platform',
      owner_id: null,
    });
    const [txnId] = await db('ledger_transaction').insert({
      ulid: 'T'.padEnd(26, '0'),
      kind: 'adjustment',
      ref_type: 'manual',
      ref_id: 1,
      idempotency_key: 'manual:1',
    });
    await expect(
      db('ledger_entry').insert({
        transaction_id: txnId,
        account_id: accountId,
        direction: 'debit',
        amount_cents: 0, // violates CHECK (amount_cents > 0)
      }),
    ).rejects.toThrow();
  });
});
