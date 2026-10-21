import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { verifyAccessToken, type VerifyAccessTokenOptions } from '../../auth/tokens';
import type { Logger } from '../logger';
import { authorizeJoin, type RealtimePrincipal, type RealtimeResolver } from './authorize';
import { createSocketGateway, type RealtimeGateway } from './gateway';
import { attachScaleAdapter } from './scale-adapter';

/**
 * Attach a Socket.IO server to the HTTP server (doc 02 §4). The handshake authenticates the JWT
 * (same RS256 verification as REST); `join`/`leave` are authorized per room with the same RBAC.
 * Single in-memory instance unless `redisUrl` is set, in which case the Redis adapter fans events
 * out across instances (Phase 8).
 */
export interface RealtimeServerDeps {
  verifyOpts: VerifyAccessTokenOptions;
  resolver: RealtimeResolver;
  logger: Logger;
  /** When set, attach the Redis adapter for multi-instance fan-out. */
  redisUrl?: string;
}

export interface Ack {
  (result: { ok: boolean; error?: string }): void;
}

export interface RealtimeServer {
  io: Server;
  gateway: RealtimeGateway;
}

declare module 'socket.io' {
  interface SocketData {
    principal?: RealtimePrincipal;
  }
}

export function createRealtimeServer(
  httpServer: HttpServer,
  deps: RealtimeServerDeps,
): RealtimeServer {
  const { verifyOpts, resolver, logger } = deps;
  const io = new Server(httpServer, { serveClient: false });
  attachScaleAdapter(io, deps.redisUrl, logger);

  // Handshake auth: the client passes its access token in `auth.token`.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length === 0) {
      next(new Error('unauthorized'));
      return;
    }
    try {
      const decoded = verifyAccessToken(token, verifyOpts);
      socket.data.principal = { ulid: decoded.sub, roles: decoded.roles };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('join', (room: unknown, ack?: Ack) => {
      const principal = socket.data.principal;
      if (typeof room !== 'string' || !principal) {
        ack?.({ ok: false, error: 'bad_request' });
        return;
      }
      authorizeJoin(principal, room, resolver)
        .then((allowed) => {
          if (allowed) {
            void socket.join(room);
            ack?.({ ok: true });
          } else {
            ack?.({ ok: false, error: 'forbidden' });
          }
        })
        .catch((err: unknown) => {
          logger.warn({ err, room }, 'realtime join failed');
          ack?.({ ok: false, error: 'error' });
        });
    });

    socket.on('leave', (room: unknown, ack?: Ack) => {
      if (typeof room === 'string') {
        void socket.leave(room);
      }
      ack?.({ ok: true });
    });
  });

  return { io, gateway: createSocketGateway(io) };
}
