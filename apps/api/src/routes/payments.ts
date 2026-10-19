import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../http/errors';
import { asyncHandler } from '../middleware/error';
import type { Actor, PaymentService } from '../payments/payment-service';

/** Payment dependencies for the app factory. */
export interface PaymentsModule {
  paymentService: PaymentService;
  requireAuth: RequestHandler;
}

const payBodySchema = z.object({
  phone: z.string().min(1).max(20).optional(),
});

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/** A client-supplied idempotency key guards re-initiation (doc 07 §3). Required for `pay`. */
function idempotencyKeyOf(req: Request): string {
  const key = req.get('Idempotency-Key');
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw badRequest('Idempotency-Key header is required', [
      { field: 'Idempotency-Key', issue: 'required' },
    ]);
  }
  if (key.length > 80) {
    throw badRequest('Idempotency-Key is too long', [
      { field: 'Idempotency-Key', issue: 'max 80' },
    ]);
  }
  return key;
}

/**
 * Payment endpoints (`/api/v1`). Requires authentication; the order + payment are the principal's
 * own (admins/ops may read). `POST /orders/:ulid/pay` starts an STK push and moves the order to
 * `payment_pending`; capture happens on the verified callback (increment 3).
 */
export function paymentsRouter(
  paymentService: PaymentService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();

  router.post(
    '/orders/:ulid/pay',
    requireAuth,
    asyncHandler(async (req, res) => {
      const idempotencyKey = idempotencyKeyOf(req);
      const { phone } = payBodySchema.parse(req.body ?? {});
      const payment = await paymentService.initiatePayment(actorOf(req), req.params.ulid!, {
        idempotencyKey,
        phone,
      });
      res.status(202).json(payment);
    }),
  );

  router.get(
    '/payments/:ulid',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.status(200).json(await paymentService.getPayment(actorOf(req), req.params.ulid!));
    }),
  );

  return router;
}
