import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error';
import { requirePolicy } from '../middleware/rbac';
import type { Actor, SettlementService } from '../settlements/settlement-service';

/** Settlement dependencies for the app factory. */
export interface SettlementsModule {
  settlementService: SettlementService;
  requireAuth: RequestHandler;
}

const periodSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodStart must be YYYY-MM-DD'),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodEnd must be YYYY-MM-DD'),
});

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/**
 * Settlement admin (`/api/v1/admin/settlements…`, doc 07 §10). Generation + reads are gated by
 * `audit:read` (admin/ops/finance); approval by `settlement:approve` (admin/finance). On-demand —
 * the period is a parameter (no scheduler this phase).
 */
export function settlementsRouter(
  settlementService: SettlementService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();

  router.post(
    '/admin/settlements/generate',
    requireAuth,
    requirePolicy('audit:read'),
    asyncHandler(async (req, res) => {
      const input = periodSchema.parse(req.body ?? {});
      res.status(201).json(await settlementService.generateSettlements(actorOf(req), input));
    }),
  );

  router.post(
    '/admin/settlements/:ulid/approve',
    requireAuth,
    requirePolicy('settlement:approve'),
    asyncHandler(async (req, res) => {
      res
        .status(200)
        .json(await settlementService.approveSettlement(actorOf(req), req.params.ulid!));
    }),
  );

  router.get(
    '/admin/settlements',
    requireAuth,
    requirePolicy('audit:read'),
    asyncHandler(async (_req, res) => {
      res.status(200).json({ items: await settlementService.listSettlements() });
    }),
  );

  router.get(
    '/admin/settlements/:ulid',
    requireAuth,
    requirePolicy('audit:read'),
    asyncHandler(async (req, res) => {
      res.status(200).json(await settlementService.getSettlement(req.params.ulid!));
    }),
  );

  return router;
}
