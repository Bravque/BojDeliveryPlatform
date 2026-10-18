import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import pinoHttp from 'pino-http';
import { errorHandler, notFoundHandler } from './middleware/error';
import type { Logger } from './platform/logger';
import { healthRouter, type HealthDeps } from './routes/health';

export interface AppDeps {
  logger: Logger;
  version: string;
  checkReadiness?: HealthDeps['checkReadiness'];
}

/** Build the Express application. Pure factory — no network/DB side effects. */
export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (req, res) => {
        const headerId = req.headers['x-request-id'];
        const id = typeof headerId === 'string' && headerId.length > 0 ? headerId : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );

  app.use(healthRouter({ version: deps.version, checkReadiness: deps.checkReadiness }));

  // Unmatched routes -> 404, then the centralized error handler (must be mounted last).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
