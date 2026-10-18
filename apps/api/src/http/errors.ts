/**
 * Typed application errors and the client-facing error envelope (doc 05 §1).
 *
 * Controllers/services throw an `AppError` (or a Zod `ZodError`); the central error handler
 * (middleware/error.ts) turns it into `{ error: { code, message, details?, requestId } }`.
 * `AppError` messages are developer-authored and safe to expose; raw/unknown errors are never
 * leaked — they become a generic 500.
 */

export interface ErrorDetail {
  /** Dotted path of the offending field, when applicable. */
  field?: string;
  issue: string;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: ErrorDetail[];

  constructor(status: number, code: string, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: ErrorDetail[]): AppError =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Unauthorized'): AppError =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Forbidden'): AppError =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Not Found'): AppError =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (code: string, message: string): AppError =>
  new AppError(409, code, message);

export const validationFailed = (details: ErrorDetail[]): AppError =>
  new AppError(422, 'VALIDATION_FAILED', 'Validation failed', details);

export const tooManyRequests = (message = 'Too many requests'): AppError =>
  new AppError(429, 'RATE_LIMITED', message);
