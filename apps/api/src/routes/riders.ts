import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error';
import { requireRole } from '../middleware/rbac';
import type { Actor, RiderService } from '../riders/rider-service';

/** Rider domain dependencies for the app factory. */
export interface RidersModule {
  riderService: RiderService;
  requireAuth: RequestHandler;
}

const applySchema = z.object({
  vehicleType: z.enum(['motorbike', 'bicycle', 'car', 'foot']),
});
const suspendSchema = z.object({ reason: z.string().min(1).max(255) });

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/**
 * Rider self-service (`/api/v1/rider…`). Any authenticated user may apply and read their own
 * profile — the `rider` role is only granted on admin approval, so these gate on auth, not role.
 */
export function riderRouter(riderService: RiderService, requireAuth: RequestHandler): Router {
  const router = express.Router();

  router.post(
    '/rider/apply',
    requireAuth,
    asyncHandler(async (req, res) => {
      const input = applySchema.parse(req.body ?? {});
      res.status(201).json(await riderService.applyAsRider(actorOf(req), input));
    }),
  );

  router.get(
    '/rider/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.status(200).json(await riderService.getOwnRider(actorOf(req)));
    }),
  );

  return router;
}

/** `POST /api/v1/admin/riders/:ulid/{approve,suspend}` — admin/ops onboarding actions. */
export function adminRiderRouter(riderService: RiderService, requireAuth: RequestHandler): Router {
  const router = express.Router();
  const adminOnly: RequestHandler[] = [requireAuth, requireRole('admin', 'ops')];

  router.post(
    '/admin/riders/:ulid/approve',
    ...adminOnly,
    asyncHandler(async (req, res) => {
      res.status(200).json(await riderService.approveRider(actorOf(req), req.params.ulid!));
    }),
  );

  router.post(
    '/admin/riders/:ulid/suspend',
    ...adminOnly,
    asyncHandler(async (req, res) => {
      const { reason } = suspendSchema.parse(req.body);
      res.status(200).json(await riderService.suspendRider(actorOf(req), req.params.ulid!, reason));
    }),
  );

  return router;
}
