import express, { type Router } from 'express';

export interface HealthDeps {
  version: string;
  /** Optional readiness checks; each entry is a dependency name -> healthy flag. */
  checkReadiness?: () => Promise<Record<string, boolean>>;
}

/** Liveness (`/health`) and readiness (`/health/ready`) endpoints. */
export function healthRouter(deps: HealthDeps): Router {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: deps.version,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/health/ready', async (_req, res) => {
    if (!deps.checkReadiness) {
      res.json({ status: 'ok', checks: {} });
      return;
    }
    const checks = await deps.checkReadiness();
    const healthy = Object.values(checks).every(Boolean);
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      checks,
    });
  });

  return router;
}
