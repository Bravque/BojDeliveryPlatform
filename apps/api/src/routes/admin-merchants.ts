import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import type { CatalogueService } from '../catalogue/catalogue-service';
import type { Actor, MerchantService } from '../merchant/merchant-service';
import { asyncHandler } from '../middleware/error';
import { requireRole } from '../middleware/rbac';

/** Merchant domain dependencies: admin onboarding + merchant-facing catalogue. */
export interface MerchantModule {
  merchantService: MerchantService;
  catalogueService: CatalogueService;
  requireAuth: RequestHandler;
}

const createSchema = z.object({
  townName: z.string().min(1),
  name: z.string().min(1).max(160),
  categoryType: z.enum(['restaurant', 'grocery', 'pharmacy', 'retail', 'other']),
  commissionBps: z.number().int().min(0).max(10000),
  prepMinutes: z.number().int().min(1).max(600).default(20),
  ownerUserUlid: z.string().min(1).optional(),
});
const suspendSchema = z.object({ reason: z.string().min(1).max(255) });
const addOwnerSchema = z.object({
  userUlid: z.string().min(1),
  role: z.enum(['owner', 'staff']).default('owner'),
});

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/** `POST /api/v1/admin/merchants…` — create, approve, suspend, link owners. Admin/ops only. */
export function merchantAdminRouter(
  merchantService: MerchantService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();
  const adminOnly: RequestHandler[] = [requireAuth, requireRole('admin', 'ops')];

  router.post(
    '/admin/merchants',
    ...adminOnly,
    asyncHandler(async (req, res) => {
      const input = createSchema.parse(req.body);
      res.status(201).json(await merchantService.createMerchant(actorOf(req), input));
    }),
  );

  router.post(
    '/admin/merchants/:ulid/approve',
    ...adminOnly,
    asyncHandler(async (req, res) => {
      res.status(200).json(await merchantService.approveMerchant(actorOf(req), req.params.ulid!));
    }),
  );

  router.post(
    '/admin/merchants/:ulid/suspend',
    ...adminOnly,
    asyncHandler(async (req, res) => {
      const { reason } = suspendSchema.parse(req.body);
      res
        .status(200)
        .json(await merchantService.suspendMerchant(actorOf(req), req.params.ulid!, reason));
    }),
  );

  router.post(
    '/admin/merchants/:ulid/owners',
    ...adminOnly,
    asyncHandler(async (req, res) => {
      const { userUlid, role } = addOwnerSchema.parse(req.body);
      res
        .status(200)
        .json(await merchantService.addOwner(actorOf(req), req.params.ulid!, userUlid, role));
    }),
  );

  return router;
}
