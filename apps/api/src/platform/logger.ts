import pino from 'pino';

export type Logger = pino.Logger;

export interface LoggerOptions {
  level?: string;
}

/** Create the structured (JSON) application logger. */
export function createLogger(options: LoggerOptions = {}): Logger {
  return pino({
    level: options.level ?? 'info',
    base: { service: 'boj-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
