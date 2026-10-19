import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import { badRequest, forbidden } from '../http/errors';
import { asyncHandler } from '../middleware/error';
import type { CaptureService } from '../payments/capture-service';
import { requirePolicy, requireRole } from '../middleware/rbac';
import type { Actor, PaymentService } from '../payments/payment-service';
import type { ReconcileService } from '../payments/reconcile-service';

/** Payment dependencies for the app factory. */
export interface PaymentsModule {
  paymentService: PaymentService;
  captureService: CaptureService;
  reconcileService: ReconcileService;
  requireAuth: RequestHandler;
  /** Shared secret the STK callback must present; when undefined the webhook rejects all. */
  webhookToken: string | undefined;
  /** Whether to mount the non-production dev simulate endpoint (NODE_ENV !== 'production'). */
  allowDevSimulate: boolean;
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

const callbackSchema = z.object({
  checkoutRequestId: z.string().min(1),
  merchantRequestId: z.string().nullish(),
  resultCode: z.number().int(),
  resultDesc: z.string().default(''),
  amountCents: z.number().int().nullish(),
  mpesaReceipt: z.string().nullish(),
});

/**
 * STK callback webhook (doc 07 §3) — no user auth; authenticated by a shared `X-Webhook-Token`.
 * Always acks 200 for a recognised request (duplicate / unknown / mismatch included) so the
 * provider does not retry forever; capture decisions live in the service.
 */
export function stkWebhookRouter(
  captureService: CaptureService,
  webhookToken: string | undefined,
): Router {
  const router = express.Router();

  router.post(
    '/webhooks/mpesa/stk',
    asyncHandler(async (req, res) => {
      if (!webhookToken || req.get('X-Webhook-Token') !== webhookToken) {
        throw forbidden('Invalid webhook token');
      }
      const callback = callbackSchema.parse(req.body);
      const outcome = await captureService.processStkResult(callback);
      res.status(200).json({ status: outcome });
    }),
  );

  return router;
}

const simulateSchema = z.object({
  outcome: z.enum(['success', 'fail']),
  amountCents: z.number().int().positive().optional(),
});

/**
 * Non-production helper to drive the simulated gateway's outcome for a payment (admin only). Mount
 * only when `NODE_ENV !== 'production'`.
 */
export function devPaymentsRouter(
  captureService: CaptureService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();

  router.post(
    '/dev/payments/:ulid/simulate',
    requireAuth,
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const { outcome, amountCents } = simulateSchema.parse(req.body);
      const result = await captureService.simulate(req.params.ulid!, outcome, amountCents);
      res.status(200).json({ status: result });
    }),
  );

  return router;
}

const reconcileSchema = z.object({
  olderThanSec: z.number().int().min(0).max(86_400).optional(),
});

/**
 * Admin reconciliation (doc 07 §5–6): resolve stale pending payments against the gateway, and a
 * read-only divergence + ledger-invariant report. Reconcile mutates (captures/fails), so it is
 * ops/admin; the report is read-only (finance/ops/admin via `audit:read`).
 */
export function adminReconcileRouter(
  reconcileService: ReconcileService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();

  router.post(
    '/admin/payments/reconcile',
    requireAuth,
    requireRole('admin', 'ops'),
    asyncHandler(async (req, res) => {
      const { olderThanSec } = reconcileSchema.parse(req.body ?? {});
      res.status(200).json(await reconcileService.reconcileStalePayments(olderThanSec));
    }),
  );

  router.get(
    '/admin/payments/reconciliation-report',
    requireAuth,
    requirePolicy('audit:read'),
    asyncHandler(async (_req, res) => {
      res.status(200).json(await reconcileService.reconciliationReport());
    }),
  );

  return router;
}
