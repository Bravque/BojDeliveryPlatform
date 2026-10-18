import express, { type RequestHandler, type Router } from 'express';
import type { AuditService } from '../auth/audit-service';
import { asyncHandler } from '../middleware/error';
import { requireRole } from '../middleware/rbac';

/**
 * Admin surface (doc 05), mounted under `/api/v1`. Phase 1 ships the audit-log view, which
 * exercises the RBAC stack end-to-end: `requireAuth` (valid token) → `requireRole` (admin/ops/
 * finance) → handler. Business admin actions (zones, commissions, refunds…) arrive later.
 */
export function adminRouter(requireAuth: RequestHandler, auditService: AuditService): Router {
  const router = express.Router();

  router.get(
    '/admin/audit-logs',
    requireAuth,
    requireRole('admin', 'ops', 'finance'),
    asyncHandler(async (_req, res) => {
      res.status(200).json({ items: await auditService.listRecent(50) });
    }),
  );

  return router;
}
