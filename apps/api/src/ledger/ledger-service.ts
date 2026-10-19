import { addCents, assertInteger } from '@boj/money';
import { newUlid } from '../auth/crypto';
import type { AccountType, OwnerType } from './accounts';
import type { LedgerRepo } from './repo';

/**
 * Posts balanced double-entry transactions. `post` is called with a transaction-bound repo by the
 * capture/refund flows, so the ledger write shares their DB transaction. It is **idempotent** (a
 * repeated `idempotencyKey` is a no-op) and **balanced** (debits must equal credits, every amount
 * positive) — the ledger invariant, enforced here and verified by reconciliation.
 */

export interface PostingLine {
  accountCode: string;
  accountType: AccountType;
  ownerType?: OwnerType;
  ownerId?: number | null;
  direction: 'debit' | 'credit';
  amountCents: number;
}

export interface PostInput {
  kind: string;
  refType: string;
  refId: number;
  idempotencyKey: string;
  lines: PostingLine[];
}

export interface PostResult {
  ulid: string;
  /** false when the transaction already existed for this idempotency key (no-op). */
  created: boolean;
}

/** Thrown when a posting's debits and credits do not balance — a server-side invariant breach. */
export class LedgerUnbalancedError extends Error {
  constructor(debits: number, credits: number) {
    super(`LEDGER_UNBALANCED: debits ${debits} != credits ${credits}`);
    this.name = 'LedgerUnbalancedError';
  }
}

function assertBalanced(lines: PostingLine[]): void {
  if (lines.length < 2) {
    throw new Error('LEDGER_INVALID: a transaction needs at least two entries');
  }
  let debits = 0;
  let credits = 0;
  for (const line of lines) {
    assertInteger(line.amountCents);
    if (line.amountCents <= 0) {
      throw new Error('LEDGER_INVALID: entry amount must be positive');
    }
    if (line.direction === 'debit') {
      debits = addCents(debits, line.amountCents);
    } else {
      credits = addCents(credits, line.amountCents);
    }
  }
  if (debits !== credits) {
    throw new LedgerUnbalancedError(debits, credits);
  }
}

export function createLedgerService() {
  async function post(repo: LedgerRepo, input: PostInput): Promise<PostResult> {
    assertBalanced(input.lines);

    const existing = await repo.findTransactionByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return { ulid: existing.ulid, created: false };
    }

    const ulid = newUlid();
    const transactionId = await repo.insertTransaction({
      ulid,
      kind: input.kind,
      refType: input.refType,
      refId: input.refId,
      idempotencyKey: input.idempotencyKey,
    });

    for (const line of input.lines) {
      const account = await repo.getOrCreateAccount({
        code: line.accountCode,
        type: line.accountType,
        ownerType: line.ownerType ?? 'platform',
        ownerId: line.ownerId ?? null,
      });
      await repo.insertEntry({
        transactionId,
        accountId: account.id,
        direction: line.direction,
        amountCents: line.amountCents,
      });
    }

    return { ulid, created: true };
  }

  return { post };
}

export type LedgerService = ReturnType<typeof createLedgerService>;
