import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server } from 'socket.io';
import type { Logger } from '../logger';

/**
 * Horizontal-scale fan-out for Socket.IO (Phase 8, doc 02 §4). When `REDIS_URL` is set, attach the
 * Redis pub/sub adapter so events emitted on one API instance reach clients connected to any
 * instance; otherwise the server stays single-instance (the default in-memory adapter). Returns
 * whether the Redis adapter was attached. A real Redis is a deploy-time concern, so only the
 * no-Redis branch is exercised in CI.
 */
export function attachScaleAdapter(
  io: Server,
  redisUrl: string | undefined,
  logger: Logger,
): boolean {
  if (!redisUrl) {
    return false;
  }
  const pub = new Redis(redisUrl);
  const sub = pub.duplicate();
  io.adapter(createAdapter(pub, sub));
  logger.info('realtime: Redis adapter attached (multi-instance fan-out)');
  return true;
}
