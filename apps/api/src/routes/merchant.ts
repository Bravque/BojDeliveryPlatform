import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import type { CatalogueService } from '../catalogue/catalogue-service';
import { asyncHandler } from '../middleware/error';
import { requireRole } from '../middleware/rbac';

const profileSchema = z
  .object({
    isOpen: z.boolean().optional(),
    prepMinutes: z.number().int().min(1).max(600).optional(),
  })
  .refine((d) => d.isOpen !== undefined || d.prepMinutes !== undefined, {
    message: 'Provide isOpen and/or prepMinutes',
  });

const categorySchema = z.object({
  name: z.string().min(1).max(120),
  sortOrder: z.number().int().min(0).default(0),
});

const productCreateSchema = z.object({
  categoryUlid: z.string().min(1).optional(),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  priceCents: z.number().int().min(0),
});

const productEditSchema = z.object({
  expectedVersion: z.number().int().min(1),
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2000).nullable().optional(),
  priceCents: z.number().int().min(0).optional(),
  categoryUlid: z.string().min(1).optional(),
});

const availabilitySchema = z.object({ isAvailable: z.boolean() });

const optionGroupSchema = z.object({
  name: z.string().min(1).max(120),
  minSelect: z.number().int().min(0).max(20).default(0),
  maxSelect: z.number().int().min(1).max(20).default(1),
});

const optionSchema = z.object({
  name: z.string().min(1).max(120),
  priceDeltaCents: z.number().int().min(0),
  isAvailable: z.boolean().optional(),
});

function actorUlid(req: Request): string {
  return req.principal!.ulid;
}

/**
 * Merchant-facing catalogue & profile management (doc 05), mounted under `/api/v1`. The role gate
 * is `requireRole('merchant_owner','merchant_staff')`; the service then resolves the caller's own
 * merchant and refuses anything outside it. Price/catalogue edits are server-authoritative.
 */
export function merchantRouter(
  catalogueService: CatalogueService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();
  const merchantOnly: RequestHandler[] = [
    requireAuth,
    requireRole('merchant_owner', 'merchant_staff'),
  ];

  router.patch(
    '/merchant/profile',
    ...merchantOnly,
    asyncHandler(async (req, res) => {
      const patch = profileSchema.parse(req.body);
      res.status(200).json(await catalogueService.updateProfile(actorUlid(req), patch));
    }),
  );

  router.post(
    '/merchant/catalogue/categories',
    ...merchantOnly,
    asyncHandler(async (req, res) => {
      const input = categorySchema.parse(req.body);
      res.status(201).json(await catalogueService.createCategory(actorUlid(req), input));
    }),
  );

  router.post(
    '/merchant/catalogue/products',
    ...merchantOnly,
    asyncHandler(async (req, res) => {
      const input = productCreateSchema.parse(req.body);
      res.status(201).json(await catalogueService.createProduct(actorUlid(req), input));
    }),
  );

  router.patch(
    '/merchant/catalogue/products/:ulid',
    ...merchantOnly,
    asyncHandler(async (req, res) => {
      const input = productEditSchema.parse(req.body);
      res
        .status(200)
        .json(await catalogueService.editProduct(actorUlid(req), req.params.ulid!, input));
    }),
  );

  router.patch(
    '/merchant/catalogue/products/:ulid/availability',
    ...merchantOnly,
    asyncHandler(async (req, res) => {
      const { isAvailable } = availabilitySchema.parse(req.body);
      res
        .status(200)
        .json(
          await catalogueService.setAvailability(actorUlid(req), req.params.ulid!, isAvailable),
        );
    }),
  );

  router.post(
    '/merchant/catalogue/products/:ulid/option-groups',
    ...merchantOnly,
    asyncHandler(async (req, res) => {
      const input = optionGroupSchema.parse(req.body);
      res
        .status(201)
        .json(await catalogueService.addOptionGroup(actorUlid(req), req.params.ulid!, input));
    }),
  );

  router.post(
    '/merchant/catalogue/option-groups/:ulid/options',
    ...merchantOnly,
    asyncHandler(async (req, res) => {
      const input = optionSchema.parse(req.body);
      res
        .status(201)
        .json(await catalogueService.addOption(actorUlid(req), req.params.ulid!, input));
    }),
  );

  router.patch(
    '/merchant/catalogue/options/:ulid/availability',
    ...merchantOnly,
    asyncHandler(async (req, res) => {
      const { isAvailable } = availabilitySchema.parse(req.body);
      res
        .status(200)
        .json(
          await catalogueService.setOptionAvailability(
            actorUlid(req),
            req.params.ulid!,
            isAvailable,
          ),
        );
    }),
  );

  return router;
}
