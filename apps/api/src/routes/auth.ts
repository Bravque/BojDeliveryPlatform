import express, { type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import type { OtpService } from '../auth/otp-service';
import type { SessionService } from '../auth/session-service';
import type { UserService } from '../auth/user-service';
import { asyncHandler } from '../middleware/error';

/** Everything the auth routes need, assembled in main.ts (or stubbed in tests). */
export interface AuthModule {
  otpService: OtpService;
  sessionService: SessionService;
  userService: UserService;
  requireAuth: RequestHandler;
}

const requestSchema = z.object({ phone: z.string().min(1) });
const verifySchema = z.object({ phone: z.string().min(1), code: z.string().min(1) });
const refreshSchema = z.object({ refresh: z.string().min(1) });
const profilePatchSchema = z.object({ displayName: z.string().min(1).max(120) });

/**
 * Auth endpoints (doc 05/06), mounted under `/api/v1`. Bodies are validated with Zod (invalid →
 * 422 via the error handler); protected routes require a valid access token via `requireAuth`.
 * `/otp/request` always returns 202 regardless of whether the number is registered.
 */
export function authRouter(auth: AuthModule): Router {
  const router = express.Router();

  router.post(
    '/auth/otp/request',
    asyncHandler(async (req, res) => {
      const { phone } = requestSchema.parse(req.body);
      await auth.otpService.requestOtp({ phone, ip: req.ip });
      res.status(202).json({ status: 'otp_sent' });
    }),
  );

  router.post(
    '/auth/otp/verify',
    asyncHandler(async (req, res) => {
      const { phone, code } = verifySchema.parse(req.body);
      res.status(200).json(await auth.otpService.verifyOtp({ phone, code, ip: req.ip }));
    }),
  );

  router.post(
    '/auth/refresh',
    asyncHandler(async (req, res) => {
      const { refresh } = refreshSchema.parse(req.body);
      res.status(200).json(await auth.sessionService.refresh(refresh));
    }),
  );

  router.post(
    '/auth/logout',
    auth.requireAuth,
    asyncHandler(async (req, res) => {
      const { refresh } = refreshSchema.parse(req.body);
      await auth.sessionService.logout(refresh);
      res.status(204).end();
    }),
  );

  router.get(
    '/me',
    auth.requireAuth,
    asyncHandler(async (req, res) => {
      res.status(200).json(await auth.userService.getProfile(req.principal!.ulid));
    }),
  );

  router.patch(
    '/me',
    auth.requireAuth,
    asyncHandler(async (req, res) => {
      const patch = profilePatchSchema.parse(req.body);
      res.status(200).json(await auth.userService.updateProfile(req.principal!.ulid, patch));
    }),
  );

  return router;
}
