import type { Knex } from 'knex';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuditService } from '../auth/audit-service';
import { newUlid } from '../auth/crypto';
import { createKnexAuthRepo } from '../auth/repo';
import { createMerchantService, type Actor } from '../merchant/merchant-service';
import { createKnexMerchantRepo } from '../merchant/repo';
import { createKnexPayoutsRepo } from '../payouts/repo';
import { buildKnexConfig, createDb } from '../platform/db';

/**
 * Merchant B2C payout destination against real MySQL (DATABASE_URL). Self-skips without one.
 * Proves migration 0023's column round-trips, the service normalizes to E.164, and the payouts repo
 * resolves a merchant payee MSISDN from it (closing the go-live gap) — null when none is on file.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('merchant payout destination integration (real MySQL)', () => {
  let db: Knex;
  let townId: number;
  let adminUlid: string;

  beforeAll(() => {
    db = createDb(buildKnexConfig({ DATABASE_URL: DATABASE_URL as string }));
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function insertMerchant(name: string): Promise<{ id: number; ulid: string }> {
    const ulid = newUlid();
    const id = Number(
      (
        await db('merchant').insert({
          ulid,
          town_id: townId,
          name,
          category_type: 'restaurant',
          status: 'approved',
          is_open: true,
          commission_bps: 1_000,
        })
      )[0],
    );
    return { id, ulid };
  }

  beforeEach(async () => {
    await db.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['audit_log', 'merchant', 'user', 'town']) {
      await db(t).truncate();
    }
    await db.raw('SET FOREIGN_KEY_CHECKS = 1');

    townId = Number(
      (await db('town').insert({ ulid: newUlid(), name: 'Migori', is_active: true }))[0],
    );
    adminUlid = newUlid();
    await db('user').insert({ ulid: adminUlid, phone_e164: '+254700000300', status: 'active' });
  });

  it('service sets + normalizes the destination, repo reads it back, payouts repo resolves it', async () => {
    const merchantRepo = createKnexMerchantRepo(db);
    const svc = createMerchantService({
      repo: merchantRepo,
      auditService: createAuditService(createKnexAuthRepo(db)),
    });
    const admin: Actor = { ulid: adminUlid, roles: ['admin'] };

    const { id, ulid } = await insertMerchant('Joe Kitchen');

    const updated = await svc.setPayoutDestination(admin, ulid, '0712 345 678');
    expect(updated.payoutPhoneE164).toBe('+254712345678');

    // Column round-trips through the merchant mapping.
    const reloaded = await merchantRepo.findMerchantByUlid(ulid);
    expect(reloaded?.payoutPhoneE164).toBe('+254712345678');

    // The payouts repo now resolves a merchant payee MSISDN (previously always null).
    const payouts = createKnexPayoutsRepo(db);
    expect(await payouts.getPayeeMsisdn('merchant', id)).toBe('+254712345678');
  });

  it('resolves null for a merchant with no destination on file', async () => {
    const { id } = await insertMerchant('No Destination Co');
    const payouts = createKnexPayoutsRepo(db);
    expect(await payouts.getPayeeMsisdn('merchant', id)).toBeNull();
  });
});
