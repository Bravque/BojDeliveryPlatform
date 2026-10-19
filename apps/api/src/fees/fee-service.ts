import type { AuditService } from '../auth/audit-service';
import { newUlid } from '../auth/crypto';
import { badRequest, notFound } from '../http/errors';
import { computeDeliveryFeeCents } from './compute';
import type { DeliveryFeeRuleRecord, DeliveryFeeRuleRepo } from './repo';

/** The acting principal (from req.principal). Resolved to a DB user id for the audit trail. */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface CreateFeeRuleInput {
  zoneUlid: string;
  baseFeeCents: number;
  perKmCents: number;
  minFeeCents: number;
  maxFeeCents?: number | null;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
}

export interface UpdateFeeRuleInput {
  baseFeeCents?: number;
  perKmCents?: number;
  minFeeCents?: number;
  maxFeeCents?: number | null;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
}

export interface FeeRuleSummary {
  ulid: string;
  baseFeeCents: number;
  perKmCents: number;
  minFeeCents: number;
  maxFeeCents: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Result of pricing a delivery: the clamped fee plus the rule and distance it was derived from. */
export interface FeeQuote {
  feeCents: number;
  ruleUlid: string;
  distanceM: number;
}

export interface FeeServiceDeps {
  repo: DeliveryFeeRuleRepo;
  auditService: AuditService;
}

function toSummary(r: DeliveryFeeRuleRecord): FeeRuleSummary {
  return {
    ulid: r.ulid,
    baseFeeCents: r.baseFeeCents,
    perKmCents: r.perKmCents,
    minFeeCents: r.minFeeCents,
    maxFeeCents: r.maxFeeCents,
    effectiveFrom: r.effectiveFrom.toISOString(),
    effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString() : null,
  };
}

function assertBounds(minFeeCents: number, maxFeeCents: number | null): void {
  if (maxFeeCents !== null && maxFeeCents < minFeeCents) {
    throw badRequest('max_fee_cents must be at least min_fee_cents', [
      { field: 'maxFeeCents', issue: 'below minFeeCents' },
    ]);
  }
}

function assertWindow(effectiveFrom: Date, effectiveTo: Date | null): void {
  if (effectiveTo !== null && effectiveTo.getTime() <= effectiveFrom.getTime()) {
    throw badRequest('effective_to must be after effective_from', [
      { field: 'effectiveTo', issue: 'not after effectiveFrom' },
    ]);
  }
}

export function createFeeService(deps: FeeServiceDeps) {
  const { repo, auditService } = deps;

  function actorRole(actor: Actor): string {
    return actor.roles.includes('admin') ? 'admin' : (actor.roles[0] ?? 'unknown');
  }

  async function audit(
    actor: Actor,
    action: string,
    entityId: number,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await auditService.record({
      actorUserId: await repo.findUserIdByUlid(actor.ulid),
      actorRole: actorRole(actor),
      action,
      entityType: 'delivery_fee_rule',
      entityId,
      before,
      after,
    });
  }

  async function requireZoneId(zoneUlid: string): Promise<number> {
    const zoneId = await repo.findZoneIdByUlid(zoneUlid);
    if (zoneId === null) {
      throw notFound('Zone not found');
    }
    return zoneId;
  }

  async function createRule(actor: Actor, input: CreateFeeRuleInput): Promise<FeeRuleSummary> {
    const zoneId = await requireZoneId(input.zoneUlid);
    const effectiveFrom = input.effectiveFrom ?? new Date();
    const effectiveTo = input.effectiveTo ?? null;
    const maxFeeCents = input.maxFeeCents ?? null;
    assertBounds(input.minFeeCents, maxFeeCents);
    assertWindow(effectiveFrom, effectiveTo);

    const rule = await repo.createRule({
      ulid: newUlid(),
      zoneId,
      baseFeeCents: input.baseFeeCents,
      perKmCents: input.perKmCents,
      minFeeCents: input.minFeeCents,
      maxFeeCents,
      effectiveFrom,
      effectiveTo,
    });
    await audit(actor, 'delivery_fee_rule.create', rule.id, null, {
      baseFeeCents: rule.baseFeeCents,
      perKmCents: rule.perKmCents,
    });
    return toSummary(rule);
  }

  async function updateRule(
    actor: Actor,
    ruleUlid: string,
    patch: UpdateFeeRuleInput,
  ): Promise<FeeRuleSummary> {
    const rule = await repo.findRuleByUlid(ruleUlid);
    if (!rule) {
      throw notFound('Delivery fee rule not found');
    }
    const next: DeliveryFeeRuleRecord = {
      ...rule,
      ...(patch.baseFeeCents !== undefined && { baseFeeCents: patch.baseFeeCents }),
      ...(patch.perKmCents !== undefined && { perKmCents: patch.perKmCents }),
      ...(patch.minFeeCents !== undefined && { minFeeCents: patch.minFeeCents }),
      ...(patch.maxFeeCents !== undefined && { maxFeeCents: patch.maxFeeCents }),
      ...(patch.effectiveFrom !== undefined && { effectiveFrom: patch.effectiveFrom }),
      ...(patch.effectiveTo !== undefined && { effectiveTo: patch.effectiveTo }),
    };
    assertBounds(next.minFeeCents, next.maxFeeCents);
    assertWindow(next.effectiveFrom, next.effectiveTo);

    await repo.updateRule(rule.id, patch);
    await audit(
      actor,
      'delivery_fee_rule.update',
      rule.id,
      { baseFeeCents: rule.baseFeeCents, perKmCents: rule.perKmCents },
      { baseFeeCents: next.baseFeeCents, perKmCents: next.perKmCents },
    );
    return toSummary(next);
  }

  async function listRules(zoneUlid: string): Promise<FeeRuleSummary[]> {
    const zoneId = await requireZoneId(zoneUlid);
    const rules = await repo.listRules(zoneId);
    return rules.map(toSummary);
  }

  /**
   * Price delivery within a zone for a given distance, using the rule in force at `at` (default
   * now). Returns null when the zone has no effective rule (a config gap the caller must handle).
   */
  async function resolveFee(
    zoneId: number,
    distanceM: number,
    at: Date = new Date(),
  ): Promise<FeeQuote | null> {
    const rule = await repo.findEffectiveRule(zoneId, at);
    if (!rule) {
      return null;
    }
    return { feeCents: computeDeliveryFeeCents(rule, distanceM), ruleUlid: rule.ulid, distanceM };
  }

  return { createRule, updateRule, listRules, resolveFee };
}

export type FeeService = ReturnType<typeof createFeeService>;
