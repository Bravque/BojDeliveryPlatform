import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error';
import type { Actor, DeviceService } from '../notifications/device-service';

/** Notification dependencies for the app factory. */
export interface NotificationsModule {
  deviceService: DeviceService;
  requireAuth: RequestHandler;
}

const registerSchema = z.object({
  pushToken: z.string().min(1).max(255),
  platform: z.enum(['ios', 'android', 'web']),
});

function actorOf(req: Request): Actor {
  const principal = req.principal!;
  return { ulid: principal.ulid, roles: principal.roles };
}

/** `POST /api/v1/devices` — register/refresh the caller's push token (any authenticated user). */
export function devicesRouter(deviceService: DeviceService, requireAuth: RequestHandler): Router {
  const router = express.Router();

  router.post(
    '/devices',
    requireAuth,
    asyncHandler(async (req, res) => {
      const input = registerSchema.parse(req.body ?? {});
      res.status(201).json(await deviceService.registerDevice(actorOf(req), input));
    }),
  );

  return router;
}
