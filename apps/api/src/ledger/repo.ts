import type { Knex } from 'knex';
import type { AccountType, OwnerType } from './accounts';

/**
 * Ledger persistence over a `Knex` executor, so a capture/refund can post its ledger transaction
 * inside the *same* DB transaction as the payment/order state change (doc 07 §1).
 */

export interface LedgerAccount {
  id: number;
  code: string;
  type: AccountType;
}

export interface GetOrCreateAccountInput {
  code: string;
  type: AccountType;
  ownerType: OwnerType;
  ownerId: number | null;
}

export interface InsertTransactionInput {
  ulid: string;
  kind: string;
  refType: string;
  refId: number;
  idempotencyKey: string;
}

export interface AccountBalance {
  code: string;
  type: AccountType;
  debitCents: number;
  creditCents: number;
}

export interface LedgerRepo {
  getOrCreateAccount(input: GetOrCreateAccountInput): Promise<LedgerAccount>;
  findTransactionByIdempotencyKey(key: string): Promise<{ id: number; ulid: string } | null>;
  insertTransaction(input: InsertTransactionInput): Promise<number>;
  insertEntry(input: {
    transactionId: number;
    accountId: number;
    direction: 'debit' | 'credit';
    amountCents: number;
  }): Promise<void>;
  getAccountBalances(): Promise<AccountBalance[]>;
}

export function createKnexLedgerRepo(exec: Knex): LedgerRepo {
  return {
    async getOrCreateAccount(input) {
      // Insert-if-absent then read, so concurrent captures racing to create the same per-owner
      // account converge on one row (UNIQUE(code)).
      await exec('ledger_account')
        .insert({
          code: input.code,
          type: input.type,
          owner_type: input.ownerType,
          owner_id: input.ownerId,
        })
        .onConflict('code')
        .ignore();
      const row = (await exec('ledger_account')
        .where({ code: input.code })
        .first('id', 'code', 'type')) as
        { id: number | string; code: string; type: AccountType } | undefined;
      if (!row) {
        throw new Error(`Failed to get-or-create ledger account ${input.code}`);
      }
      return { id: Number(row.id), code: row.code, type: row.type };
    },

    async findTransactionByIdempotencyKey(key) {
      const row = (await exec('ledger_transaction')
        .where({ idempotency_key: key })
        .first('id', 'ulid')) as { id: number | string; ulid: string } | undefined;
      return row ? { id: Number(row.id), ulid: row.ulid } : null;
    },

    async insertTransaction(input) {
      const inserted = await exec('ledger_transaction').insert({
        ulid: input.ulid,
        kind: input.kind,
        ref_type: input.refType,
        ref_id: input.refId,
        idempotency_key: input.idempotencyKey,
      });
      const id = inserted[0];
      if (id === undefined) {
        throw new Error('Failed to insert ledger transaction');
      }
      return Number(id);
    },

    async insertEntry(input) {
      await exec('ledger_entry').insert({
        transaction_id: input.transactionId,
        account_id: input.accountId,
        direction: input.direction,
        amount_cents: input.amountCents,
      });
    },

    async getAccountBalances() {
      const rows = (await exec('ledger_account as a')
        .leftJoin('ledger_entry as e', 'e.account_id', 'a.id')
        .groupBy('a.id', 'a.code', 'a.type')
        .select('a.code as code', 'a.type as type')
        .select(
          exec.raw(
            "COALESCE(SUM(CASE WHEN e.direction = 'debit' THEN e.amount_cents ELSE 0 END), 0) as debit_cents",
          ),
          exec.raw(
            "COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_cents ELSE 0 END), 0) as credit_cents",
          ),
        )) as Array<{
        code: string;
        type: AccountType;
        debit_cents: number | string;
        credit_cents: number | string;
      }>;
      return rows.map((r) => ({
        code: r.code,
        type: r.type,
        debitCents: Number(r.debit_cents),
        creditCents: Number(r.credit_cents),
      }));
    },
  };
}
