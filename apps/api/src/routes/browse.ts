import express, { type Router } from 'express';
import type { BrowseService } from '../browse/service';
import { asyncHandler } from '../middleware/error';

/** Bundles the public catalogue reads for the app factory. */
export interface BrowseModule {
  browseService: BrowseService;
}

/**
 * Public catalogue reads (doc 05), mounted under `/api/v1`. **No authentication** — these are
 * the customer-facing browse endpoints. Visibility (approved + open merchants, available
 * products/options) is enforced in the service/repo, never here.
 */
export function browseRouter(browseService: BrowseService): Router {
  const router = express.Router();

  router.get(
    '/towns',
    asyncHandler(async (_req, res) => {
      res.status(200).json({ items: await browseService.listTowns() });
    }),
  );

  router.get(
    '/merchants',
    asyncHandler(async (req, res) => {
      const townName = typeof req.query.townName === 'string' ? req.query.townName : undefined;
      const category = typeof req.query.category === 'string' ? req.query.category : undefined;
      res.status(200).json({ items: await browseService.listMerchants({ townName, category }) });
    }),
  );

  router.get(
    '/merchants/:ulid',
    asyncHandler(async (req, res) => {
      res.status(200).json(await browseService.getMerchant(req.params.ulid!));
    }),
  );

  router.get(
    '/merchants/:ulid/catalogue',
    asyncHandler(async (req, res) => {
      res.status(200).json(await browseService.getMerchantCatalogue(req.params.ulid!));
    }),
  );

  router.get(
    '/products/:ulid',
    asyncHandler(async (req, res) => {
      res.status(200).json(await browseService.getProduct(req.params.ulid!));
    }),
  );

  return router;
}
