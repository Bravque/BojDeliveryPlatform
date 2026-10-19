import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error';
import { requireRole } from '../middleware/rbac';
import type { PresenceService } from '../riders/presence-service';
import type { Actor, RiderService } from '../riders/rider-service';

/** Rider domain dependencies for the app factory. */
export interface RidersModule {
  riderService: RiderService;
  presenceService: PresenceService;
  requireAuth: RequestHandler;
}

const applySchema = z.object({
  vehicleType: z.enum(['motorbike', 'bicycle', 'car', 'foot']),
});
const suspendSchema = z.object({ reason: z.string().min(1).max(255) });
const pingSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

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

/**
 * Rider presence (`/api/v1/rider/{online,offline,ping}`) — approved riders only. These feed
 * candidate selection in increment 4 (`is_online` + ping freshness).
 */
export function presenceRouter(
  presenceService: PresenceService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();
  const riderOnly: RequestHandler[] = [requireAuth, requireRole('rider')];

  router.post(
    '/rider/online',
    ...riderOnly,
    asyncHandler(async (req, res) => {
      res.status(200).json(await presenceService.goOnline(actorOf(req)));
    }),
  );

  router.post(
    '/rider/offline',
    ...riderOnly,
    asyncHandler(async (req, res) => {
      res.status(200).json(await presenceService.goOffline(actorOf(req)));
    }),
  );

  router.post(
    '/rider/ping',
    ...riderOnly,
    asyncHandler(async (req, res) => {
      const { lat, lng } = pingSchema.parse(req.body ?? {});
      res.status(200).json(await presenceService.ping(actorOf(req), { lat, lng }));
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
