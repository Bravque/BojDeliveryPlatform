import type { ErrorRequestHandler, RequestHandler } from 'express';

/**
 * Wrap an async route handler so a rejected promise is forwarded to Express's error pipeline.
 *
 * The project is pinned to **Express 4** (see the workspace dependency catalog), which does
 * NOT catch errors thrown from async handlers automatically — an unhandled rejection would
 * otherwise leave the request hanging. Express 5 forwards async errors natively, so this
 * wrapper can be removed if/when the app moves to Express 5.
 */
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Catch-all 404 for unmatched routes. Mount it after all routers. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { message: 'Not Found', requestId: String(req.id) } });
};

/**
 * Final error handler. Logs the full error (including stack) server-side only and returns a
 * generic payload, so stack traces, SQL errors, env values and other internals never reach
 * the client. Must keep all four parameters for Express to treat it as error middleware.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  req.log.error({ err }, 'Unhandled request error');
  if (res.headersSent) {
    return;
  }
  res.status(500).json({ error: { message: 'Internal Server Error', requestId: String(req.id) } });
};
