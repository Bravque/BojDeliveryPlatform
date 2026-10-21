import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newUlid } from '../auth/crypto';
import { createApp } from '../app';
import { createLedgerService } from '../ledger/ledger-service';
import { createKnexLedgerRepo } from '../ledger/repo';
import { merchantPayableCode } from '../ledger/accounts';
import { createPayoutService } from '../payouts/payout-service';
import { createKnexPayoutsRepo } from '../payouts/repo';
import { SimulatedPayoutGateway } from '../payouts/gateway';
import { createAuditService } from '../auth/audit-service';
import { createKnexAuthRepo } from '../auth/repo';
import { buildKnexConfig, createDb } from '../platform/db';
import { createLogger } from '../platform/logger';

/** Daraja B2C result webhook → payout paid, against real MySQL (DATABASE_URL). Self-skips without one. */
const DATABASE_URL = process.env.DATABASE_URL;
const TOKEN = 'b2c-int-secret';

describe.skipIf(!DATABASE_URL)('payout B2C-result integration (real MySQL)', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let merchantId: number;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
    app = createApp({
      logger: createLogger({ level: 'silent' }),
      version: 'int',
      payouts: {
        payoutService: createPayoutService({
          withTransaction: (work) =>
            db.transaction((trx) =>
              work({ payouts: createKnexPayoutsRepo(trx), ledger: createKnexLedgerRepo(trx) }),
            ),
          ledgerService: createLedgerService(),
          gateway: new SimulatedPayoutGateway(),
          auditService: createAuditService(createKnexAuthRepo(db)),
        }),
        requireAuth: (_req, _res, next) => next(),
        webhookToken: TOKEN,
        allowDevSimulate: false,
      },
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  let settlementId: number;
  let payoutId: number;
  const conversationId = 'AG_CONV_INT_1';

  beforeEach(async () => {
    await db.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [
      'payout_event',
      'payout_line',
      'payout',
      'settlement',
      'ledger_entry',
      'ledger_transaction',
      'ledger_account',
      'merchant',
      'town',
    ]) {
      await db(t).truncate();
    }
    await db.raw('SET FOREIGN_KEY_CHECKS = 1');

    const townId = Number(
      (await db('town').insert({ ulid: newUlid(), name: 'Migori', is_active: true }))[0],
    );
    merchantId = Number(
      (
        await db('merchant').insert({
          ulid: newUlid(),
          town_id: townId,
          name: 'Joe Kitchen',
          category_type: 'restaurant',
          status: 'approved',
          is_open: true,
          commission_bps: 1_000,
        })
      )[0],
    );

    // Accrued payable (as capture would), so the payout draws it back down to zero.
    await createLedgerService().post(createKnexLedgerRepo(db), {
      kind: 'order_capture',
      refType: 'payment',
      refId: 1,
      idempotencyKey: 'seed-capture',
      lines: [
        {
          accountCode: 'mpesa_clearing',
          accountType: 'asset',
          direction: 'debit',
          amountCents: 40_000,
        },
        {
          accountCode: merchantPayableCode(merchantId),
          accountType: 'liability',
          ownerType: 'merchant',
          ownerId: merchantId,
          direction: 'credit',
          amountCents: 40_000,
        },
      ],
    });

    settlementId = Number(
      (
        await db('settlement').insert({
          ulid: newUlid(),
          merchant_id: merchantId,
          period_start: '2026-10-01',
          period_end: '2026-10-07',
          gross_cents: 50_000,
          commission_cents: 10_000,
          refunds_cents: 0,
          net_cents: 40_000,
          status: 'approved',
        })
      )[0],
    );
    // A payout already executed (processing) with the provider conversation id as external_ref.
    payoutId = Number(
      (
        await db('payout').insert({
          ulid: newUlid(),
          payee_type: 'merchant',
          payee_id: merchantId,
          amount_cents: 40_000,
          status: 'processing',
          method: 'mpesa_b2c',
          external_ref: conversationId,
          idempotency_key: `settlement:${settlementId}`,
        })
      )[0],
    );
    await db('payout_line').insert({
      payout_id: payoutId,
      ref_type: 'settlement',
      ref_id: settlementId,
      amount_cents: 40_000,
    });
  });

  const b2cResult = (resultCode: number) => ({
    Result: {
      ResultType: 0,
      ResultCode: resultCode,
      ResultDesc: resultCode === 0 ? 'ok' : 'failed',
      OriginatorConversationID: 'oc-int',
      ConversationID: conversationId,
      TransactionID: 'TXINT',
    },
  });

  async function payoutTxnCount(): Promise<number> {
    const rows = (await db('ledger_transaction')
      .where('kind', 'payout')
      .count({ c: '*' })) as Array<{ c: number | string }>;
    return Number(rows[0]?.c ?? 0);
  }

  it('a success B2C result pays the payout, draws down the payable, marks the settlement paid; replay dedupes', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/mpesa/b2c-result')
      .set('X-Webhook-Token', TOKEN)
      .send(b2cResult(0));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');

    expect((await db('payout').where({ id: payoutId }).first('status')).status).toBe('paid');
    expect((await db('settlement').where({ id: settlementId }).first('status')).status).toBe(
      'paid',
    );
    expect(await payoutTxnCount()).toBe(1);

    const balances = await createKnexLedgerRepo(db).getAccountBalances();
    const payable = balances.find((b) => b.code === merchantPayableCode(merchantId))!;
    expect(payable.creditCents - payable.debitCents).toBe(0);

    expect(await db('payout_event')).toHaveLength(1);

    // Replay the exact same result → deduped, no second ledger posting.
    const replay = await request(app)
      .post('/api/v1/webhooks/mpesa/b2c-result')
      .set('X-Webhook-Token', TOKEN)
      .send(b2cResult(0));
    expect(replay.body.status).toBe('duplicate');
    expect(await payoutTxnCount()).toBe(1);
    expect(await db('payout_event')).toHaveLength(1);
  });

  it('a failure B2C result marks the payout failed and posts nothing', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/mpesa/b2c-result')
      .set('X-Webhook-Token', TOKEN)
      .send(b2cResult(2001));
    expect(res.body.status).toBe('failed');
    expect((await db('payout').where({ id: payoutId }).first('status')).status).toBe('failed');
    expect(await payoutTxnCount()).toBe(0);
  });
});
