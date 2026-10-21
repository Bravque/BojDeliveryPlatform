import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../auth/repo';
import { createSettlementService, type Actor } from './settlement-service';
import type { DeliveredOrderRow, SettlementRecord, SettlementsRepo } from './repo';

const FINANCE: Actor = { ulid: 'FIN', roles: ['finance'] };

function makeRepo(rows: DeliveredOrderRow[]) {
  const settlements: SettlementRecord[] = [];
  const lines: Array<{ settlementId: number; orderId: number; netCents: number }> = [];
  const ulidByMerchant = new Map(rows.map((r) => [r.merchantId, r.merchantUlid]));
  let seq = 0;
  const repo = {
    findUserIdByUlid: () => Promise.resolve(42),
    listDeliveredOrdersForPeriod: () => Promise.resolve(rows),
    findSettlement: (merchantId: number, ps: string, pe: string) =>
      Promise.resolve(
        settlements.find(
          (s) => s.merchantId === merchantId && s.periodStart === ps && s.periodEnd === pe,
        ) ?? null,
      ),
    insertSettlement: (
      input: Omit<SettlementRecord, 'id' | 'merchantUlid' | 'status' | 'approvedBy'>,
    ) => {
      const id = ++seq;
      settlements.push({
        ...input,
        id,
        merchantUlid: ulidByMerchant.get(input.merchantId) ?? 'M?',
        status: 'draft',
        approvedBy: null,
      });
      return Promise.resolve(id);
    },
    insertSettlementLine: (input: { settlementId: number; orderId: number; netCents: number }) => {
      lines.push({
        settlementId: input.settlementId,
        orderId: input.orderId,
        netCents: input.netCents,
      });
      return Promise.resolve();
    },
    findSettlementByUlid: (ulid: string) =>
      Promise.resolve(settlements.find((s) => s.ulid === ulid) ?? null),
    lockSettlementByUlid: (ulid: string) =>
      Promise.resolve(settlements.find((s) => s.ulid === ulid) ?? null),
    setSettlementApproved: (id: number) => {
      const s = settlements.find((x) => x.id === id);
      if (s) s.status = 'approved';
      return Promise.resolve();
    },
    listSettlements: () => Promise.resolve(settlements),
  } as unknown as SettlementsRepo;

  const audits: Partial<AuditEntry>[] = [];
  const svc = createSettlementService({
    withTransaction: (work) => work(repo),
    auditService: {
      record: (e: Partial<AuditEntry> & Pick<AuditEntry, 'action' | 'entityType'>) => {
        audits.push(e);
        return Promise.resolve();
      },
      listRecent: () => Promise.resolve([]),
    },
  });
  return { svc, settlements, lines, audits };
}

const ROWS: DeliveredOrderRow[] = [
  {
    merchantId: 1,
    merchantUlid: 'MA',
    orderId: 1,
    subtotalCents: 30_000,
    commissionCents: 3_000,
    refundsCents: 0,
  },
  {
    merchantId: 1,
    merchantUlid: 'MA',
    orderId: 2,
    subtotalCents: 20_000,
    commissionCents: 2_000,
    refundsCents: 5_000,
  },
  {
    merchantId: 2,
    merchantUlid: 'MB',
    orderId: 3,
    subtotalCents: 10_000,
    commissionCents: 1_000,
    refundsCents: 0,
  },
];

const period = { periodStart: '2026-10-01', periodEnd: '2026-10-07' };

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

describe('settlement service', () => {
  it('generates one settlement per merchant with net = gross − commission − refunds', async () => {
    const { svc } = makeRepo(ROWS);
    const res = await svc.generateSettlements(FINANCE, period);
    expect(res.generated).toBe(2);

    const a = res.settlements.find((s) => s.merchantUlid === 'MA')!;
    expect(a).toMatchObject({
      grossCents: 50_000,
      commissionCents: 5_000,
      refundsCents: 5_000,
      netCents: 40_000,
    });
    const b = res.settlements.find((s) => s.merchantUlid === 'MB')!;
    expect(b).toMatchObject({
      grossCents: 10_000,
      commissionCents: 1_000,
      refundsCents: 0,
      netCents: 9_000,
    });
  });

  it('is idempotent — re-generating the same period skips existing settlements', async () => {
    const { svc } = makeRepo(ROWS);
    await svc.generateSettlements(FINANCE, period);
    const again = await svc.generateSettlements(FINANCE, period);
    expect(again.generated).toBe(0);
    expect(again.skipped).toBe(2);
  });

  it('approves a draft settlement and rejects a second approval (409)', async () => {
    const { svc } = makeRepo(ROWS);
    const { settlements } = await svc.generateSettlements(FINANCE, period);
    const ulid = settlements[0]!.ulid;
    expect((await svc.approveSettlement(FINANCE, ulid)).status).toBe('approved');
    expect(await thrownStatus(svc.approveSettlement(FINANCE, ulid))).toBe(409);
  });

  it('404s approving an unknown settlement', async () => {
    const { svc } = makeRepo(ROWS);
    expect(await thrownStatus(svc.approveSettlement(FINANCE, 'nope'))).toBe(404);
  });

  it('records settlement lines summing to the settlement net', async () => {
    const { svc, lines } = makeRepo(ROWS);
    await svc.generateSettlements(FINANCE, period);
    // Merchant A (settlement id 1) has two lines netting 27000 + 13000 = 40000.
    const aLines = lines.filter((l) => l.settlementId === 1);
    expect(aLines.reduce((s, l) => s + l.netCents, 0)).toBe(40_000);
  });
});
