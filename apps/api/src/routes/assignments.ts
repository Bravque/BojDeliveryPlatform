import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import type { Actor, AssignmentService } from '../delivery/assignment-service';
import { asyncHandler } from '../middleware/error';
import { requireRole } from '../middleware/rbac';

/** Rider assignment dependencies for the app factory. */
export interface DeliveryModule {
  assignmentService: AssignmentService;
  requireAuth: RequestHandler;
}

const offerIdSchema = z.coerce.number().int().positive();

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/**
 * Rider-facing assignment (`/api/v1/rider/offers…`). A rider polls their live offers and
 * accepts/declines. Accept is atomic (first-wins → 409 `OFFER_ALREADY_TAKEN` for the rest).
 */
export function riderOffersRouter(
  assignmentService: AssignmentService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();
  const riderOnly: RequestHandler[] = [requireAuth, requireRole('rider')];

  router.get(
    '/rider/offers',
    ...riderOnly,
    asyncHandler(async (req, res) => {
      res.status(200).json({ items: await assignmentService.listOffers(actorOf(req)) });
    }),
  );

  router.post(
    '/rider/offers/:id/accept',
    ...riderOnly,
    asyncHandler(async (req, res) => {
      const offerId = offerIdSchema.parse(req.params.id);
      res.status(200).json(await assignmentService.acceptOffer(actorOf(req), offerId));
    }),
  );

  router.post(
    '/rider/offers/:id/decline',
    ...riderOnly,
    asyncHandler(async (req, res) => {
      const offerId = offerIdSchema.parse(req.params.id);
      res.status(200).json(await assignmentService.declineOffer(actorOf(req), offerId));
    }),
  );

  return router;
}

/**
 * Admin assignment tick (`POST /api/v1/admin/assignments/tick`). Expires stale offers and offers
 * waiting `ready_for_pickup` orders — the manual/dev driver standing in for a scheduler this phase.
 */
export function adminAssignmentsRouter(
  assignmentService: AssignmentService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();

  router.post(
    '/admin/assignments/tick',
    requireAuth,
    requireRole('admin', 'ops'),
    asyncHandler(async (_req, res) => {
      res.status(200).json(await assignmentService.tick());
    }),
  );

  return router;
}
