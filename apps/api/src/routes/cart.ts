import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import type { Actor, CartService } from '../cart/cart-service';
import { asyncHandler } from '../middleware/error';

/** Cart dependencies for the app factory. */
export interface CartModule {
  cartService: CartService;
  requireAuth: RequestHandler;
}

const quantitySchema = z.number().int().min(1).max(99);

const addItemSchema = z.object({
  productUlid: z.string().min(1),
  quantity: quantitySchema,
  optionUlids: z.array(z.string().min(1)).max(50).optional(),
});

const updateItemSchema = z.object({
  quantity: quantitySchema,
});

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/**
 * Customer cart (`/api/v1/cart…`). Requires authentication; the cart is always the authenticated
 * principal's own (never taken from the client). Single-merchant and option-selection rules are
 * enforced in the service.
 */
export function cartRouter(cartService: CartService, requireAuth: RequestHandler): Router {
  const router = express.Router();

  router.get(
    '/cart',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.status(200).json(await cartService.getCart(actorOf(req)));
    }),
  );

  router.post(
    '/cart/items',
    requireAuth,
    asyncHandler(async (req, res) => {
      const input = addItemSchema.parse(req.body);
      res.status(201).json(await cartService.addItem(actorOf(req), input));
    }),
  );

  router.patch(
    '/cart/items/:ulid',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { quantity } = updateItemSchema.parse(req.body);
      res
        .status(200)
        .json(await cartService.updateQuantity(actorOf(req), req.params.ulid!, quantity));
    }),
  );

  router.delete(
    '/cart/items/:ulid',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.status(200).json(await cartService.removeItem(actorOf(req), req.params.ulid!));
    }),
  );

  router.delete(
    '/cart',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.status(200).json(await cartService.clearCart(actorOf(req)));
    }),
  );

  return router;
}
