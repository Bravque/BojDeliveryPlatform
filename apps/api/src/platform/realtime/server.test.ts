import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { signAccessToken } from '../../auth/tokens';
import { createLogger } from '../logger';
import type { RealtimeResolver } from './authorize';
import { createRealtimeServer, type RealtimeServer } from './server';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

function tokenFor(ulid: string, roles: string[]): string {
  return signAccessToken(
    { sub: ulid, roles, jti: 'j' },
    { privateKey, expiresInSec: 900, issuer: ISSUER, audience: AUDIENCE },
  );
}

const resolver: RealtimeResolver = {
  orderParticipants: (ulid) =>
    Promise.resolve(
      ulid === 'ORD1' ? { customerUlid: 'CUST', merchantUlid: 'MERCH', riderUlid: null } : null,
    ),
  merchantStaffUlids: () => Promise.resolve([]),
};

describe('realtime socket server', () => {
  let httpServer: HttpServer;
  let realtime: RealtimeServer;
  let port: number;
  const clients: Socket[] = [];

  beforeAll(async () => {
    httpServer = createServer();
    realtime = createRealtimeServer(httpServer, {
      verifyOpts: { publicKey, issuer: ISSUER, audience: AUDIENCE },
      resolver,
      logger: createLogger({ level: 'silent' }),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(() => {
    for (const c of clients.splice(0)) {
      c.close();
    }
  });

  afterAll(async () => {
    await realtime.io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  function connect(token: string | undefined): Promise<Socket> {
    const socket = ioClient(`http://localhost:${port}`, {
      auth: token === undefined ? {} : { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    clients.push(socket);
    return new Promise<Socket>((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', (err) => reject(err));
    });
  }

  function join(socket: Socket, room: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => socket.emit('join', room, resolve));
  }

  it('accepts a connection with a valid token', async () => {
    const socket = await connect(tokenFor('CUST', ['customer']));
    expect(socket.connected).toBe(true);
  });

  it('rejects a connection with a missing/invalid token', async () => {
    await expect(connect('garbage.token.value')).rejects.toThrow('unauthorized');
    await expect(connect(undefined)).rejects.toThrow('unauthorized');
  });

  it('authorizes a join for an entitled principal', async () => {
    const socket = await connect(tokenFor('CUST', ['customer']));
    expect(await join(socket, 'order:ORD1')).toEqual({ ok: true });
  });

  it('rejects an unauthorized join', async () => {
    const socket = await connect(tokenFor('STRANGER', ['customer']));
    expect(await join(socket, 'order:ORD1')).toMatchObject({ ok: false, error: 'forbidden' });
  });
});
