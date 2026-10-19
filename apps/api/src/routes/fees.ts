import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import type { Actor, FeeService } from '../fees/fee-service';
import { asyncHandler } from '../middleware/error';
import { requirePolicy } from '../middleware/rbac';

/** Delivery-fee configuration dependencies. */
export interface FeesModule {
  feeService: FeeService;
  requireAuth: RequestHandler;
}

const centsSchema = z.number().int().min(0);

const createFeeRuleSchema = z.object({
  baseFeeCents: centsSchema,
  perKmCents: centsSchema.default(0),
  minFeeCents: centsSchema,
  maxFeeCents: centsSchema.nullish(),
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().nullish(),
});

const updateFeeRuleSchema = z.object({
  baseFeeCents: centsSchema.optional(),
  perKmCents: centsSchema.optional(),
  minFeeCents: centsSchema.optional(),
  maxFeeCents: centsSchema.nullish(),
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().nullish(),
});

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/**
 * Admin delivery-fee configuration (`/api/v1/admin/...`). Fee rules are platform configuration
 * (D3), so the policy gate is `config:write` (admin only). Rules are created and listed under a
 * zone; updates address a rule by its own ulid.
 */
export function adminFeeRulesRouter(feeService: FeeService, requireAuth: RequestHandler): Router {
  const router = express.Router();
  const adminConfig: RequestHandler[] = [requireAuth, requirePolicy('config:write')];

  router.post(
    '/admin/zones/:zoneUlid/fee-rules',
    ...adminConfig,
    asyncHandler(async (req, res) => {
      const body = createFeeRuleSchema.parse(req.body);
      res
        .status(201)
        .json(
          await feeService.createRule(actorOf(req), { zoneUlid: req.params.zoneUlid!, ...body }),
        );
    }),
  );

  router.get(
    '/admin/zones/:zoneUlid/fee-rules',
    ...adminConfig,
    asyncHandler(async (req, res) => {
      res.status(200).json({ items: await feeService.listRules(req.params.zoneUlid!) });
    }),
  );

  router.patch(
    '/admin/fee-rules/:ulid',
    ...adminConfig,
    asyncHandler(async (req, res) => {
      const patch = updateFeeRuleSchema.parse(req.body);
      res.status(200).json(await feeService.updateRule(actorOf(req), req.params.ulid!, patch));
    }),
  );

  return router;
}
