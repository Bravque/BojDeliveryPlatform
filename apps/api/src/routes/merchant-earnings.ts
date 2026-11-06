import express, { type Request, type RequestHandler, type Router } from 'express';
import { asyncHandler } from '../middleware/error';
import { requireRole } from '../middleware/rbac';
import type { Actor, SettlementService } from '../settlements/settlement-service';

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/**
 * Merchant-facing earnings (`/api/v1/merchant/settlements`). Read-only: the merchant sees its own
 * settlements (period, gross, commission, refunds, net, status). The service resolves the caller's
 * merchant and returns only that merchant's rows — a parallel to the admin settlements endpoints
 * (which are gated on `audit:read`), but gated here to merchant owners/staff.
 */
export function merchantEarningsRouter(
  settlementService: SettlementService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();
  const merchantOnly: RequestHandler[] = [
    requireAuth,
    requireRole('merchant_owner', 'merchant_staff'),
  ];

  router.get(
    '/merchant/settlements',
    ...merchantOnly,
    asyncHandler(async (req, res) => {
      res
        .status(200)
        .json({ items: await settlementService.listMerchantSettlements(actorOf(req)) });
    }),
  );

  return router;
}
