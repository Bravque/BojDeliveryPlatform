import type { Server } from 'socket.io';

/**
 * The emit API that domain code calls to push realtime notifications (increment 2 wires the domain
 * events to it). Rooms are ulid-keyed. A no-op implementation is used wherever realtime is not
 * attached (the Express `createApp` factory + most tests), so services stay decoupled from transport.
 */
export interface RealtimeGateway {
  emitOrder(orderUlid: string, event: string, payload: unknown): void;
  emitRider(userUlid: string, event: string, payload: unknown): void;
  emitMerchant(merchantUlid: string, event: string, payload: unknown): void;
}

export const noopGateway: RealtimeGateway = {
  emitOrder() {},
  emitRider() {},
  emitMerchant() {},
};

/** A gateway that broadcasts to the `kind:{ulid}` Socket.IO rooms. */
export function createSocketGateway(io: Server): RealtimeGateway {
  return {
    emitOrder(orderUlid, event, payload) {
      io.to(`order:${orderUlid}`).emit(event, payload);
    },
    emitRider(userUlid, event, payload) {
      io.to(`rider:${userUlid}`).emit(event, payload);
    },
    emitMerchant(merchantUlid, event, payload) {
      io.to(`merchant:${merchantUlid}`).emit(event, payload);
    },
  };
}
