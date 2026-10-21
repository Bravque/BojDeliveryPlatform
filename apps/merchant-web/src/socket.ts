import { io } from 'socket.io-client';

/** Something we can tear down when leaving the dashboard. */
export interface SocketHandle {
  close(): void;
}

/**
 * Connect to the realtime gateway, join the merchant's room, and invoke `onEvent` whenever a new or
 * updated order arrives. The callback carries no state — the dashboard re-fetches via REST on every
 * nudge (realtime payloads are notifications only).
 */
export type ConnectMerchantSocket = (
  token: string,
  merchantUlid: string,
  onEvent: () => void,
) => SocketHandle;

export function makeConnectMerchantSocket(baseUrl: string): ConnectMerchantSocket {
  return (token, merchantUlid, onEvent) => {
    const socket = io(baseUrl, { auth: { token }, transports: ['websocket'] });
    socket.on('connect', () => socket.emit('join', `merchant:${merchantUlid}`));
    socket.on('order.new', onEvent);
    socket.on('order.updated', onEvent);
    return { close: () => socket.close() };
  };
}
