import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error';
import type { FulfillmentService } from '../orders/fulfillment-service';
import type { Actor, OrderService } from '../orders/order-service';

/** Customer order dependencies for the app factory. */
export interface OrdersModule {
  orderService: OrderService;
  /** Merchant-driven progression (accept/preparing/ready/reject). */
  fulfillmentService: FulfillmentService;
  requireAuth: RequestHandler;
}

const createOrderSchema = z.object({
  addressUlid: z.string().min(1),
  promoCode: z.string().min(1).max(40).optional(),
});

const cancelOrderSchema = z.object({
  reason: z.string().min(1).max(255).optional(),
});

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/**
 * Customer orders (`/api/v1/orders…`). Requires authentication; orders are the principal's own
 * (admins/ops may also read/cancel). Creation converts the cart to a `draft` order with a stock
 * reservation + full price snapshot, all in one transaction.
 */
export function ordersRouter(orderService: OrderService, requireAuth: RequestHandler): Router {
  const router = express.Router();

  router.post(
    '/orders',
    requireAuth,
    asyncHandler(async (req, res) => {
      const input = createOrderSchema.parse(req.body);
      res.status(201).json(await orderService.createOrder(actorOf(req), input));
    }),
  );

  router.get(
    '/orders',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.status(200).json({ items: await orderService.listOrders(actorOf(req)) });
    }),
  );

  router.get(
    '/orders/:ulid',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.status(200).json(await orderService.getOrder(actorOf(req), req.params.ulid!));
    }),
  );

  router.post(
    '/orders/:ulid/cancel',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { reason } = cancelOrderSchema.parse(req.body ?? {});
      res.status(200).json(await orderService.cancelOrder(actorOf(req), req.params.ulid!, reason));
    }),
  );

  return router;
}
