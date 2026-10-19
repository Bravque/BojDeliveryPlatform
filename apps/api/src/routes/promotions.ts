import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error';
import { requirePolicy } from '../middleware/rbac';
import type { Actor, PromotionService } from '../promotions/promotion-service';

/** Admin promotion-management dependencies. */
export interface PromotionsModule {
  promotionService: PromotionService;
  requireAuth: RequestHandler;
}

const createPromotionSchema = z.object({
  code: z.string().min(1).max(40),
  type: z.enum(['percentage', 'fixed', 'free_delivery']),
  valueBps: z.number().int().positive().max(10_000).nullish(),
  valueCents: z.number().int().positive().nullish(),
  maxDiscountCents: z.number().int().positive().nullish(),
  minSubtotalCents: z.number().int().min(0).optional(),
  perUserLimit: z.number().int().min(1).optional(),
  totalLimit: z.number().int().min(1).nullish(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  isActive: z.boolean().optional(),
});

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/**
 * Admin promotion management (`/api/v1/admin/promotions`). Promotions are platform configuration,
 * so the policy gate is `config:write` (admin only). Server-controlled — the client never sets a
 * discount.
 */
export function adminPromotionsRouter(
  promotionService: PromotionService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();
  const adminConfig: RequestHandler[] = [requireAuth, requirePolicy('config:write')];

  router.post(
    '/admin/promotions',
    ...adminConfig,
    asyncHandler(async (req, res) => {
      const input = createPromotionSchema.parse(req.body);
      res.status(201).json(await promotionService.createPromotion(actorOf(req), input));
    }),
  );

  router.get(
    '/admin/promotions',
    ...adminConfig,
    asyncHandler(async (_req, res) => {
      res.status(200).json({ items: await promotionService.listPromotions() });
    }),
  );

  return router;
}
