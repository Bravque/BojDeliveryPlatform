import { describe, expect, it } from 'vitest';
import type { AuditService } from '../auth/audit-service';
import type { PromotionRecord } from './promotion';
import { createPromotionService, type Actor } from './promotion-service';
import type { CreatePromotionInput, PromotionRepo } from './repo';

class FakePromotionRepo implements PromotionRepo {
  rows: PromotionRecord[] = [];
  private seq = 0;

  findUserIdByUlid(): Promise<number | null> {
    return Promise.resolve(11);
  }
  createPromotion(input: CreatePromotionInput): Promise<PromotionRecord> {
    const rec: PromotionRecord = { id: ++this.seq, totalRedeemed: 0, ...input };
    this.rows.push(rec);
    return Promise.resolve(rec);
  }
  findPromotionByCode(code: string): Promise<PromotionRecord | null> {
    return Promise.resolve(this.rows.find((p) => p.code === code) ?? null);
  }
  listPromotions(): Promise<PromotionRecord[]> {
    return Promise.resolve(this.rows);
  }
}

function fakeAudit(): { service: AuditService; entries: Array<{ action: string }> } {
  const entries: Array<{ action: string }> = [];
  const service = {
    record: (e: { action: string }) => {
      entries.push(e);
      return Promise.resolve();
    },
    listRecent: () => Promise.resolve([]),
  } as unknown as AuditService;
  return { service, entries };
}

const ADMIN: Actor = { ulid: 'admin', roles: ['admin'] };

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

function makeSvc(repo = new FakePromotionRepo()) {
  const audit = fakeAudit();
  return { repo, audit, svc: createPromotionService({ repo, auditService: audit.service }) };
}

const starts = new Date('2026-01-01T00:00:00Z');
const ends = new Date('2026-12-31T00:00:00Z');

describe('promotion service — admin create', () => {
  it('creates a percentage promotion, upper-cases the code, and audits it', async () => {
    const { svc, audit } = makeSvc();
    const promo = await svc.createPromotion(ADMIN, {
      code: 'save10',
      type: 'percentage',
      valueBps: 1_000,
      startsAt: starts,
      endsAt: ends,
    });
    expect(promo.code).toBe('SAVE10');
    expect(promo.perUserLimit).toBe(1); // default
    expect(audit.entries.map((e) => e.action)).toContain('promotion.create');
  });

  it('requires valueBps for percentage and valueCents for fixed (400)', async () => {
    const { svc } = makeSvc();
    expect(
      await thrownStatus(
        svc.createPromotion(ADMIN, {
          code: 'A',
          type: 'percentage',
          startsAt: starts,
          endsAt: ends,
        }),
      ),
    ).toBe(400);
    expect(
      await thrownStatus(
        svc.createPromotion(ADMIN, { code: 'B', type: 'fixed', startsAt: starts, endsAt: ends }),
      ),
    ).toBe(400);
  });

  it('rejects a window where ends_at is not after starts_at (400)', async () => {
    const { svc } = makeSvc();
    expect(
      await thrownStatus(
        svc.createPromotion(ADMIN, {
          code: 'C',
          type: 'free_delivery',
          startsAt: ends,
          endsAt: starts,
        }),
      ),
    ).toBe(400);
  });

  it('creates a free_delivery promotion with no value', async () => {
    const { svc } = makeSvc();
    const promo = await svc.createPromotion(ADMIN, {
      code: 'FREESHIP',
      type: 'free_delivery',
      startsAt: starts,
      endsAt: ends,
    });
    expect(promo.type).toBe('free_delivery');
    expect(promo.valueBps).toBeNull();
    expect(promo.valueCents).toBeNull();
  });
});

describe('promotion service — resolveDiscount', () => {
  it('404-style 422s an unknown code', async () => {
    const { svc } = makeSvc();
    const status = await svc
      .resolveDiscount('NOPE', {
        subtotalCents: 1,
        deliveryFeeCents: 0,
        serviceFeeCents: 0,
        at: new Date(),
      })
      .then(
        () => undefined,
        (e: { status?: number; code?: string }) => `${e.status}:${e.code}`,
      );
    expect(status).toBe('422:PROMO_NOT_FOUND');
  });

  it('resolves a normalized code to its discount', async () => {
    const { svc } = makeSvc();
    await svc.createPromotion(ADMIN, {
      code: 'save10',
      type: 'percentage',
      valueBps: 1_000,
      startsAt: starts,
      endsAt: ends,
    });
    const resolved = await svc.resolveDiscount('save10', {
      subtotalCents: 100_000,
      deliveryFeeCents: 15_000,
      serviceFeeCents: 0,
      at: new Date('2026-06-01T00:00:00Z'),
    });
    expect(resolved.discountCents).toBe(10_000);
    expect(resolved.promotion.code).toBe('SAVE10');
  });
});
