import { io } from 'socket.io-client';

/** Something we can tear down when leaving the tracking screen. */
export interface SocketHandle {
  close(): void;
}

/**
 * Connect to the realtime gateway, join the order's room, and invoke `onEvent` on every status
 * change. The callback carries no state — the app re-fetches the order via REST on each nudge
 * (realtime payloads are notifications only). Mirrors the merchant-web socket helper.
 */
export type ConnectOrderSocket = (
  token: string,
  orderUlid: string,
  onEvent: () => void,
) => SocketHandle;

export function makeConnectOrderSocket(baseUrl: string): ConnectOrderSocket {
  return (token, orderUlid, onEvent) => {
    const socket = io(baseUrl, { auth: { token }, transports: ['websocket'] });
    socket.on('connect', () => socket.emit('join', `order:${orderUlid}`));
    socket.on('status.changed', onEvent);
    return { close: () => socket.close() };
  };
}
