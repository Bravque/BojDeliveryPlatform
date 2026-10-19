import { describe, expect, it } from 'vitest';
import type { AuditService } from '../auth/audit-service';
import { createFeeService, type Actor } from './fee-service';
import type {
  CreateFeeRuleInput,
  DeliveryFeeRuleRecord,
  DeliveryFeeRuleRepo,
  UpdateFeeRulePatch,
} from './repo';

class FakeFeeRuleRepo implements DeliveryFeeRuleRepo {
  zones = new Map<string, number>([['Z1', 1]]);
  rules: DeliveryFeeRuleRecord[] = [];
  private seq = 0;

  findZoneIdByUlid(ulid: string): Promise<number | null> {
    return Promise.resolve(this.zones.get(ulid) ?? null);
  }
  findUserIdByUlid(): Promise<number | null> {
    return Promise.resolve(99);
  }
  createRule(input: CreateFeeRuleInput): Promise<DeliveryFeeRuleRecord> {
    const rule: DeliveryFeeRuleRecord = { id: ++this.seq, ...input };
    this.rules.push(rule);
    return Promise.resolve(rule);
  }
  findRuleByUlid(ulid: string): Promise<DeliveryFeeRuleRecord | null> {
    return Promise.resolve(this.rules.find((r) => r.ulid === ulid) ?? null);
  }
  listRules(zoneId: number): Promise<DeliveryFeeRuleRecord[]> {
    return Promise.resolve(this.rules.filter((r) => r.zoneId === zoneId));
  }
  updateRule(id: number, patch: UpdateFeeRulePatch): Promise<void> {
    const r = this.rules.find((rule) => rule.id === id);
    if (r) {
      Object.assign(r, patch);
    }
    return Promise.resolve();
  }
  findEffectiveRule(zoneId: number, at: Date): Promise<DeliveryFeeRuleRecord | null> {
    const covering = this.rules
      .filter(
        (r) =>
          r.zoneId === zoneId &&
          r.effectiveFrom.getTime() <= at.getTime() &&
          (r.effectiveTo === null || r.effectiveTo.getTime() > at.getTime()),
      )
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
    return Promise.resolve(covering[0] ?? null);
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

const ADMIN: Actor = { ulid: 'admin-ulid', roles: ['admin'] };

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

const validCreate = {
  zoneUlid: 'Z1',
  baseFeeCents: 10_000,
  perKmCents: 2_000,
  minFeeCents: 10_000,
  maxFeeCents: 20_000,
};

function makeSvc(repo = new FakeFeeRuleRepo()) {
  const audit = fakeAudit();
  return { repo, audit, svc: createFeeService({ repo, auditService: audit.service }) };
}

describe('fee service — admin configuration', () => {
  it('creates a rule and records an audit entry', async () => {
    const { svc, audit } = makeSvc();
    const rule = await svc.createRule(ADMIN, validCreate);
    expect(rule.baseFeeCents).toBe(10_000);
    expect(rule.effectiveTo).toBeNull();
    expect(typeof rule.effectiveFrom).toBe('string'); // ISO
    expect(audit.entries.map((e) => e.action)).toContain('delivery_fee_rule.create');
  });

  it('404s for an unknown zone on create and list', async () => {
    const { svc } = makeSvc();
    expect(await thrownStatus(svc.createRule(ADMIN, { ...validCreate, zoneUlid: 'nope' }))).toBe(
      404,
    );
    expect(await thrownStatus(svc.listRules('nope'))).toBe(404);
  });

  it('rejects max < min with 400', async () => {
    const { svc } = makeSvc();
    expect(
      await thrownStatus(
        svc.createRule(ADMIN, { ...validCreate, minFeeCents: 20_000, maxFeeCents: 10_000 }),
      ),
    ).toBe(400);
  });

  it('rejects effectiveTo not after effectiveFrom with 400', async () => {
    const { svc } = makeSvc();
    const from = new Date('2026-01-02T00:00:00Z');
    const to = new Date('2026-01-01T00:00:00Z');
    expect(
      await thrownStatus(
        svc.createRule(ADMIN, { ...validCreate, effectiveFrom: from, effectiveTo: to }),
      ),
    ).toBe(400);
  });

  it('lists rules for a zone', async () => {
    const { svc } = makeSvc();
    await svc.createRule(ADMIN, validCreate);
    const list = await svc.listRules('Z1');
    expect(list).toHaveLength(1);
    expect(list[0]?.maxFeeCents).toBe(20_000);
  });

  it('404s when updating an unknown rule, 400 when the update breaks min/max', async () => {
    const { svc } = makeSvc();
    expect(await thrownStatus(svc.updateRule(ADMIN, 'nope', { baseFeeCents: 1 }))).toBe(404);
    const created = await svc.createRule(ADMIN, validCreate);
    expect(await thrownStatus(svc.updateRule(ADMIN, created.ulid, { minFeeCents: 30_000 }))).toBe(
      400,
    );
  });
});

describe('fee service — resolveFee', () => {
  it('prices delivery using the effective rule', async () => {
    const { svc, repo } = makeSvc();
    await svc.createRule(ADMIN, {
      ...validCreate,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
    });
    const zoneId = repo.zones.get('Z1')!;
    const quote = await svc.resolveFee(zoneId, 3_000);
    expect(quote?.feeCents).toBe(16_000); // 10000 + 2000*3
    expect(quote?.distanceM).toBe(3_000);
  });

  it('returns null when no rule is in force', async () => {
    const { svc } = makeSvc();
    expect(await svc.resolveFee(1, 3_000)).toBeNull(); // zone 1 has no rules
  });

  it('ignores a rule whose window has not started yet', async () => {
    const { svc, repo } = makeSvc();
    await svc.createRule(ADMIN, {
      ...validCreate,
      effectiveFrom: new Date('2999-01-01T00:00:00Z'),
    });
    const zoneId = repo.zones.get('Z1')!;
    expect(await svc.resolveFee(zoneId, 3_000, new Date('2026-01-01T00:00:00Z'))).toBeNull();
  });
});
