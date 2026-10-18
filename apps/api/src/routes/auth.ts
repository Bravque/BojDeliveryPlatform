import express, { type Router } from 'express';
import { z } from 'zod';
import type { OtpService } from '../auth/otp-service';
import { asyncHandler } from '../middleware/error';

const requestSchema = z.object({ phone: z.string().min(1) });
const verifySchema = z.object({ phone: z.string().min(1), code: z.string().min(1) });

/**
 * Phone-OTP auth endpoints (doc 05). Mounted under `/api/v1`. Body shape is validated with Zod
 * (invalid → 422 via the error handler); phone format + throttling + verification live in the
 * OTP service. `/otp/request` always returns 202 regardless of whether the number is registered
 * (no user enumeration).
 */
export function authRouter(otpService: OtpService): Router {
  const router = express.Router();

  router.post(
    '/auth/otp/request',
    asyncHandler(async (req, res) => {
      const { phone } = requestSchema.parse(req.body);
      await otpService.requestOtp({ phone, ip: req.ip });
      res.status(202).json({ status: 'otp_sent' });
    }),
  );

  router.post(
    '/auth/otp/verify',
    asyncHandler(async (req, res) => {
      const { phone, code } = verifySchema.parse(req.body);
      const result = await otpService.verifyOtp({ phone, code, ip: req.ip });
      res.status(200).json(result);
    }),
  );

  return router;
}
