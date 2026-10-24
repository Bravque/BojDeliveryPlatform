import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import type { Logger } from '../logger';
import { attachScaleAdapter } from './scale-adapter';

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('attachScaleAdapter', () => {
  let io: Server | null = null;
  let http: HttpServer | null = null;
  afterEach(() => {
    io?.close();
    http?.close();
    io = null;
    http = null;
  });

  it('stays single-instance (default in-memory adapter) when no REDIS_URL is set', () => {
    http = createServer();
    io = new Server(http);
    const attached = attachScaleAdapter(io, undefined, logger);
    expect(attached).toBe(false);
    // The default in-memory adapter is `Adapter`; the Redis one would be `RedisAdapter`.
    expect(io.of('/').adapter.constructor.name).toBe('Adapter');
  });
});
