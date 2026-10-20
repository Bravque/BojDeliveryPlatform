import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import type { Actor, AssignmentService } from '../delivery/assignment-service';
import type { DeliveryService } from '../delivery/delivery-service';
import { asyncHandler } from '../middleware/error';
import { requireRole } from '../middleware/rbac';

/** Rider assignment + delivery dependencies for the app factory. */
export interface DeliveryModule {
  assignmentService: AssignmentService;
  deliveryService: DeliveryService;
  requireAuth: RequestHandler;
}

const offerIdSchema = z.coerce.number().int().positive();
const completeSchema = z.object({ pin: z.string().min(1).max(12) });
const overrideSchema = z.object({ reason: z.string().min(1).max(255) });

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

/**
 * Delivery execution (`/api/v1/…`). The rider walks the assigned order through pickup → out →
 * delivered; the customer issues the proof-of-delivery PIN (D7); an admin can override a failed
 * PIN (audited). `:ulid` is the order ulid (a delivery is 1:1 with its order).
 */
export function deliveriesRouter(
  deliveryService: DeliveryService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();
  const riderOnly: RequestHandler[] = [requireAuth, requireRole('rider')];

  router.post(
    '/rider/deliveries/:ulid/pickup',
    ...riderOnly,
    asyncHandler(async (req, res) => {
      res.status(200).json(await deliveryService.confirmPickup(actorOf(req), req.params.ulid!));
    }),
  );

  router.post(
    '/rider/deliveries/:ulid/start',
    ...riderOnly,
    asyncHandler(async (req, res) => {
      res.status(200).json(await deliveryService.startDelivery(actorOf(req), req.params.ulid!));
    }),
  );

  router.post(
    '/rider/deliveries/:ulid/complete',
    ...riderOnly,
    asyncHandler(async (req, res) => {
      const { pin } = completeSchema.parse(req.body ?? {});
      res
        .status(200)
        .json(await deliveryService.completeDelivery(actorOf(req), req.params.ulid!, pin));
    }),
  );

  router.get(
    '/rider/deliveries/:ulid',
    ...riderOnly,
    asyncHandler(async (req, res) => {
      res.status(200).json(await deliveryService.getDelivery(actorOf(req), req.params.ulid!));
    }),
  );

  // Customer issues/refreshes their own delivery PIN (owns the order; enforced in the service).
  router.post(
    '/orders/:ulid/delivery-pin',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.status(200).json(await deliveryService.issueDeliveryPin(actorOf(req), req.params.ulid!));
    }),
  );

  // Admin override for a legitimate PIN failure (audited).
  router.post(
    '/admin/deliveries/:ulid/override-complete',
    requireAuth,
    requireRole('admin', 'ops'),
    asyncHandler(async (req, res) => {
      const { reason } = overrideSchema.parse(req.body);
      res
        .status(200)
        .json(
          await deliveryService.completeDeliveryOverride(actorOf(req), req.params.ulid!, reason),
        );
    }),
  );

  return router;
}
