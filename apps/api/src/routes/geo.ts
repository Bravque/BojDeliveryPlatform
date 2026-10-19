import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import type { AddressService, Actor } from '../addresses/address-service';
import { asyncHandler } from '../middleware/error';
import { requirePolicy } from '../middleware/rbac';
import type { ZoneService } from '../zones/zone-service';

/** Geo domain dependencies: admin zone configuration + customer address book. */
export interface GeoModule {
  zoneService: ZoneService;
  addressService: AddressService;
  requireAuth: RequestHandler;
}

const latSchema = z.number().min(-90).max(90);
const lngSchema = z.number().min(-180).max(180);
const radiusSchema = z.number().int().positive().max(100_000); // metres (≤ 100 km)

const createZoneSchema = z.object({
  townName: z.string().min(1),
  name: z.string().min(1).max(120),
  centerLat: latSchema,
  centerLng: lngSchema,
  radiusM: radiusSchema,
  isActive: z.boolean().optional(),
});

const updateZoneSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  centerLat: latSchema.optional(),
  centerLng: lngSchema.optional(),
  radiusM: radiusSchema.optional(),
  isActive: z.boolean().optional(),
});

const createAddressSchema = z.object({
  label: z.string().max(60).nullish(),
  line1: z.string().min(1).max(200),
  lat: latSchema,
  lng: lngSchema,
});

const updateAddressSchema = z.object({
  label: z.string().max(60).nullish(),
  line1: z.string().min(1).max(200).optional(),
  lat: latSchema.optional(),
  lng: lngSchema.optional(),
});

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/**
 * Admin zone configuration (`/api/v1/admin/zones…`). Zones are platform configuration (D1), so
 * the policy gate is `config:write` (admin only), not a merchant/ops role.
 */
export function adminZonesRouter(zoneService: ZoneService, requireAuth: RequestHandler): Router {
  const router = express.Router();
  const adminConfig: RequestHandler[] = [requireAuth, requirePolicy('config:write')];

  router.post(
    '/admin/zones',
    ...adminConfig,
    asyncHandler(async (req, res) => {
      const input = createZoneSchema.parse(req.body);
      res.status(201).json(await zoneService.createZone(actorOf(req), input));
    }),
  );

  router.patch(
    '/admin/zones/:ulid',
    ...adminConfig,
    asyncHandler(async (req, res) => {
      const patch = updateZoneSchema.parse(req.body);
      res.status(200).json(await zoneService.updateZone(actorOf(req), req.params.ulid!, patch));
    }),
  );

  router.get(
    '/admin/zones',
    ...adminConfig,
    asyncHandler(async (req, res) => {
      const townName = typeof req.query.townName === 'string' ? req.query.townName : undefined;
      res.status(200).json({ items: await zoneService.listZones(townName) });
    }),
  );

  return router;
}

/**
 * Customer address book (`/api/v1/addresses…`). Requires authentication; every address is scoped
 * to the authenticated principal in the service (ownership is never taken from the client).
 */
export function addressesRouter(
  addressService: AddressService,
  requireAuth: RequestHandler,
): Router {
  const router = express.Router();

  router.post(
    '/addresses',
    requireAuth,
    asyncHandler(async (req, res) => {
      const input = createAddressSchema.parse(req.body);
      res.status(201).json(await addressService.createAddress(actorOf(req), input));
    }),
  );

  router.get(
    '/addresses',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.status(200).json({ items: await addressService.listAddresses(actorOf(req)) });
    }),
  );

  router.patch(
    '/addresses/:ulid',
    requireAuth,
    asyncHandler(async (req, res) => {
      const patch = updateAddressSchema.parse(req.body);
      res
        .status(200)
        .json(await addressService.updateAddress(actorOf(req), req.params.ulid!, patch));
    }),
  );

  router.delete(
    '/addresses/:ulid',
    requireAuth,
    asyncHandler(async (req, res) => {
      await addressService.deleteAddress(actorOf(req), req.params.ulid!);
      res.status(204).end();
    }),
  );

  return router;
}
