import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error';
import { requireRole } from '../middleware/rbac';
import type { Actor, FulfillmentService } from '../orders/fulfillment-service';

const rejectSchema = z.object({ reason: z.string().min(1).max(255) });

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/**
 * Merchant order progression (`/api/v1/merchant/orders/:ulid/…`). The merchant walks a `placed`
 * order to `ready_for_pickup` (where rider assignment begins) or rejects it. Gated to merchant
 * owners/staff (ownership enforced in the service) plus admin/ops.
 */
export function merchantOrdersRouter(
  fulfillmentService: FulfillmentService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();
  const staffOnly: RequestHandler[] = [
    requireAuth,
    requireRole('merchant_owner', 'merchant_staff', 'admin', 'ops'),
  ];

  router.post(
    '/merchant/orders/:ulid/accept',
    ...staffOnly,
    asyncHandler(async (req, res) => {
      res.status(200).json(await fulfillmentService.acceptOrder(actorOf(req), req.params.ulid!));
    }),
  );

  router.post(
    '/merchant/orders/:ulid/preparing',
    ...staffOnly,
    asyncHandler(async (req, res) => {
      res.status(200).json(await fulfillmentService.startPreparing(actorOf(req), req.params.ulid!));
    }),
  );

  router.post(
    '/merchant/orders/:ulid/ready',
    ...staffOnly,
    asyncHandler(async (req, res) => {
      res
        .status(200)
        .json(await fulfillmentService.markReadyForPickup(actorOf(req), req.params.ulid!));
    }),
  );

  router.post(
    '/merchant/orders/:ulid/reject',
    ...staffOnly,
    asyncHandler(async (req, res) => {
      const { reason } = rejectSchema.parse(req.body);
      res
        .status(200)
        .json(await fulfillmentService.rejectOrder(actorOf(req), req.params.ulid!, reason));
    }),
  );

  return router;
}
