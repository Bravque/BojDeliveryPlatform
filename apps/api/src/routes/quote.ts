import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error';
import type { Actor, QuoteService } from '../pricing/quote-service';

/** Cart-quote dependencies for the app factory. */
export interface PricingModule {
  quoteService: QuoteService;
  requireAuth: RequestHandler;
}

const quoteSchema = z.object({
  addressUlid: z.string().min(1),
  promoCode: z.string().min(1).max(40).optional(),
});

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/**
 * `POST /api/v1/cart/quote` — the authoritative, server-computed price breakdown for the caller's
 * cart delivered to one of their addresses. Read-only: it reserves no stock and redeems no
 * promotion. Requires authentication; cart + address are the principal's own.
 */
export function quoteRouter(quoteService: QuoteService, requireAuth: RequestHandler): Router {
  const router = express.Router();

  router.post(
    '/cart/quote',
    requireAuth,
    asyncHandler(async (req, res) => {
      const input = quoteSchema.parse(req.body);
      res.status(200).json(await quoteService.quote(actorOf(req), input));
    }),
  );

  return router;
}
