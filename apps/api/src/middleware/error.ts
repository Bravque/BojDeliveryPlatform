import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, type ErrorDetail } from '../http/errors';

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
  res
    .status(404)
    .json({ error: { code: 'NOT_FOUND', message: 'Not Found', requestId: String(req.id) } });
};

/**
 * Final error handler → doc-05 envelope `{ error: { code, message, details?, requestId } }`.
 *
 * `AppError` and Zod validation errors carry a safe, client-facing message; everything else is
 * logged server-side (with stack) and returned as a generic 500, so stack traces, SQL errors,
 * env values and other internals never reach the client. Keeps all four parameters so Express
 * treats it as error middleware.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) {
    return;
  }
  const requestId = String(req.id);

  if (err instanceof AppError) {
    if (err.status >= 500) {
      req.log.error({ err }, 'Request error');
    } else {
      req.log.warn({ code: err.code, status: err.status }, 'Request rejected');
    }
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details && { details: err.details }),
        requestId,
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    const details: ErrorDetail[] = err.issues.map((issue) => ({
      ...(issue.path.length > 0 && { field: issue.path.join('.') }),
      issue: issue.message,
    }));
    req.log.warn({ code: 'VALIDATION_FAILED' }, 'Request rejected');
    res.status(422).json({
      error: { code: 'VALIDATION_FAILED', message: 'Validation failed', details, requestId },
    });
    return;
  }

  req.log.error({ err }, 'Unhandled request error');
  res
    .status(500)
    .json({ error: { code: 'INTERNAL', message: 'Internal Server Error', requestId } });
};
