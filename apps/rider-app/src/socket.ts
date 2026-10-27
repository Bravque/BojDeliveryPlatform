import { io } from 'socket.io-client';

/** Something we can tear down when going offline / leaving the offers screen. */
export interface SocketHandle {
  close(): void;
}

/**
 * Connect to the realtime gateway and invoke `onOffer` whenever the server pushes a new offer.
 * The server auto-joins the rider to its personal `rider:{ulid}` room on connect, so the client
 * needs no explicit join and never has to know its own ulid. The callback carries no state — the
 * app re-fetches live offers via REST on each nudge (realtime payloads are notifications only).
 * Mirrors the customer-app order-socket helper.
 */
export type ConnectRiderSocket = (token: string, onOffer: () => void) => SocketHandle;

export function makeConnectRiderSocket(baseUrl: string): ConnectRiderSocket {
  return (token, onOffer) => {
    const socket = io(baseUrl, { auth: { token }, transports: ['websocket'] });
    socket.on('offer.new', onOffer);
    return { close: () => socket.close() };
  };
}
