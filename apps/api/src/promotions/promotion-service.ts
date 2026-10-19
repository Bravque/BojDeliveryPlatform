import type { AuditService } from '../auth/audit-service';
import { newUlid } from '../auth/crypto';
import { badRequest, unprocessable } from '../http/errors';
import {
  evaluatePromotion,
  type PromotionContext,
  type PromotionRecord,
  type PromotionType,
} from './promotion';
import type { PromotionRepo } from './repo';

export interface Actor {
  ulid: string;
  roles: string[];
}

export interface CreatePromotionInput {
  code: string;
  type: PromotionType;
  valueBps?: number | null;
  valueCents?: number | null;
  maxDiscountCents?: number | null;
  minSubtotalCents?: number;
  perUserLimit?: number;
  totalLimit?: number | null;
  startsAt: Date;
  endsAt: Date;
  isActive?: boolean;
}

export interface PromotionSummary {
  ulid: string;
  code: string;
  type: PromotionType;
  valueBps: number | null;
  valueCents: number | null;
  maxDiscountCents: number | null;
  minSubtotalCents: number;
  perUserLimit: number;
  totalLimit: number | null;
  totalRedeemed: number;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}

export interface PromotionServiceDeps {
  repo: PromotionRepo;
  auditService: AuditService;
}

function toSummary(p: PromotionRecord): PromotionSummary {
  return {
    ulid: p.ulid,
    code: p.code,
    type: p.type,
    valueBps: p.valueBps,
    valueCents: p.valueCents,
    maxDiscountCents: p.maxDiscountCents,
    minSubtotalCents: p.minSubtotalCents,
    perUserLimit: p.perUserLimit,
    totalLimit: p.totalLimit,
    totalRedeemed: p.totalRedeemed,
    startsAt: p.startsAt.toISOString(),
    endsAt: p.endsAt.toISOString(),
    isActive: p.isActive,
  };
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function createPromotionService(deps: PromotionServiceDeps) {
  const { repo, auditService } = deps;

  function actorRole(actor: Actor): string {
    return actor.roles.includes('admin') ? 'admin' : (actor.roles[0] ?? 'unknown');
  }

  /** Validate the type-specific value fields and the validity window. */
  function validate(input: CreatePromotionInput): void {
    if (input.endsAt.getTime() <= input.startsAt.getTime()) {
      throw badRequest('ends_at must be after starts_at', [
        { field: 'endsAt', issue: 'not after startsAt' },
      ]);
    }
    if (input.type === 'percentage') {
      if (input.valueBps === undefined || input.valueBps === null || input.valueBps <= 0) {
        throw badRequest('percentage promotions need a positive valueBps', [
          { field: 'valueBps', issue: 'required for percentage' },
        ]);
      }
    } else if (input.type === 'fixed') {
      if (input.valueCents === undefined || input.valueCents === null || input.valueCents <= 0) {
        throw badRequest('fixed promotions need a positive valueCents', [
          { field: 'valueCents', issue: 'required for fixed' },
        ]);
      }
    }
  }

  async function createPromotion(
    actor: Actor,
    input: CreatePromotionInput,
  ): Promise<PromotionSummary> {
    validate(input);
    const promo = await repo.createPromotion({
      ulid: newUlid(),
      code: normalizeCode(input.code),
      type: input.type,
      valueBps: input.type === 'percentage' ? (input.valueBps ?? null) : null,
      valueCents: input.type === 'fixed' ? (input.valueCents ?? null) : null,
      maxDiscountCents: input.maxDiscountCents ?? null,
      minSubtotalCents: input.minSubtotalCents ?? 0,
      perUserLimit: input.perUserLimit ?? 1,
      totalLimit: input.totalLimit ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      isActive: input.isActive ?? true,
    });
    await auditService.record({
      actorUserId: await repo.findUserIdByUlid(actor.ulid),
      actorRole: actorRole(actor),
      action: 'promotion.create',
      entityType: 'promotion',
      entityId: promo.id,
      before: null,
      after: { code: promo.code, type: promo.type },
    });
    return toSummary(promo);
  }

  async function listPromotions(): Promise<PromotionSummary[]> {
    return (await repo.listPromotions()).map(toSummary);
  }

  /**
   * Resolve a code to its capped discount for the given context, or throw a 422. Reused by the
   * quote (preview, no `priorUserRedemptions`) and by checkout (increment 5, which supplies the
   * per-user count and records the redemption).
   */
  async function resolveDiscount(
    code: string,
    ctx: PromotionContext,
    priorUserRedemptions?: number,
  ): Promise<{ promotion: PromotionRecord; discountCents: number }> {
    const promo = await repo.findPromotionByCode(normalizeCode(code));
    if (!promo) {
      throw unprocessable('PROMO_NOT_FOUND', 'Promotion code not found');
    }
    const discountCents = evaluatePromotion(promo, ctx, priorUserRedemptions);
    return { promotion: promo, discountCents };
  }

  return { createPromotion, listPromotions, resolveDiscount };
}

export type PromotionService = ReturnType<typeof createPromotionService>;
