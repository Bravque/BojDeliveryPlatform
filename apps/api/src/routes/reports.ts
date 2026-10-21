import express, { type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error';
import { requirePolicy } from '../middleware/rbac';
import type { ReportService } from '../reports/report-service';

/** Reporting dependencies for the app factory. */
export interface ReportsModule {
  reportService: ReportService;
  requireAuth: RequestHandler;
}

const periodSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodStart must be YYYY-MM-DD'),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodEnd must be YYYY-MM-DD'),
});

/**
 * Admin/finance reporting (`/api/v1/admin/reports…`, doc 11). Strictly read-only and gated by
 * `audit:read` (admin/ops/finance). `summary` takes the period as query params; `ledger` is the
 * finance reconciliation overview (balances + the ledger-invariant check). No money moves here.
 */
export function reportsRouter(reportService: ReportService, requireAuth: RequestHandler): Router {
  const router = express.Router();

  router.get(
    '/admin/reports/summary',
    requireAuth,
    requirePolicy('audit:read'),
    asyncHandler(async (req, res) => {
      const period = periodSchema.parse(req.query);
      res.status(200).json(await reportService.summary(period));
    }),
  );

  router.get(
    '/admin/reports/ledger',
    requireAuth,
    requirePolicy('audit:read'),
    asyncHandler(async (_req, res) => {
      res.status(200).json(await reportService.ledgerOverview());
    }),
  );

  return router;
}
