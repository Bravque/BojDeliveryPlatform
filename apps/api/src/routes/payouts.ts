import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error';
import { requirePolicy, requireRole } from '../middleware/rbac';
import type { Actor, PayoutService } from '../payouts/payout-service';

/** Payout dependencies for the app factory. */
export interface PayoutsModule {
  payoutService: PayoutService;
  requireAuth: RequestHandler;
  /** Mount the non-production dev B2C-confirm endpoint (NODE_ENV !== 'production'). */
  allowDevSimulate: boolean;
}

const periodSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodStart must be YYYY-MM-DD'),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodEnd must be YYYY-MM-DD'),
});
const simulateSchema = z.object({ outcome: z.enum(['success', 'fail']) });

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/**
 * Payout admin (`/api/v1/admin/payouts…`, doc 07 §10). Dual-sign: a payout needs a finance approval
 * AND an ops approval (two distinct users) before it can execute (simulated B2C). The ledger
 * draw-down posts only on a confirmed `paid` result.
 */
export function payoutsRouter(payoutService: PayoutService, requireAuth: RequestHandler): Router {
  const router = express.Router();

  router.post(
    '/admin/payouts/generate',
    requireAuth,
    requirePolicy('audit:read'),
    asyncHandler(async (req, res) => {
      const input = periodSchema.parse(req.body ?? {});
      res.status(201).json(await payoutService.generatePayouts(actorOf(req), input));
    }),
  );

  router.post(
    '/admin/payouts/:ulid/approve-finance',
    requireAuth,
    requirePolicy('payout:approve'),
    asyncHandler(async (req, res) => {
      res.status(200).json(await payoutService.approveFinance(actorOf(req), req.params.ulid!));
    }),
  );

  router.post(
    '/admin/payouts/:ulid/approve-ops',
    requireAuth,
    requireRole('ops', 'admin'),
    asyncHandler(async (req, res) => {
      res.status(200).json(await payoutService.approveOps(actorOf(req), req.params.ulid!));
    }),
  );

  router.post(
    '/admin/payouts/:ulid/execute',
    requireAuth,
    requirePolicy('payout:approve'),
    asyncHandler(async (req, res) => {
      res.status(200).json(await payoutService.executePayout(actorOf(req), req.params.ulid!));
    }),
  );

  router.get(
    '/admin/payouts',
    requireAuth,
    requirePolicy('audit:read'),
    asyncHandler(async (_req, res) => {
      res.status(200).json({ items: await payoutService.listPayouts() });
    }),
  );

  router.get(
    '/admin/payouts/:ulid',
    requireAuth,
    requirePolicy('audit:read'),
    asyncHandler(async (req, res) => {
      res.status(200).json(await payoutService.getPayout(req.params.ulid!));
    }),
  );

  return router;
}

/** Non-production helper to confirm the simulated B2C outcome for a payout (admin only). */
export function devPayoutsRouter(
  payoutService: PayoutService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();
  router.post(
    '/dev/payouts/:ulid/simulate',
    requireAuth,
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const { outcome } = simulateSchema.parse(req.body);
      res.status(200).json({ status: await payoutService.simulate(req.params.ulid!, outcome) });
    }),
  );
  return router;
}
