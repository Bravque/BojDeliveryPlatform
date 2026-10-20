/**
 * Socket.IO room authorization (doc 05 §3, doc 06). A socket may only join a room it is entitled to,
 * using the **same RBAC as REST**. Rooms are ulid-keyed:
 *   - `order:{orderUlid}`    — admin/ops, the customer, a staff member of the order's merchant, or the assigned rider.
 *   - `rider:{userUlid}`     — that rider only.
 *   - `merchant:{merchantUlid}` — admin/ops or a staff member of that merchant.
 * Realtime payloads are notifications only; clients re-fetch canonical state via REST.
 */

export interface RealtimePrincipal {
  ulid: string;
  roles: string[];
}

export interface OrderParticipants {
  customerUlid: string;
  merchantUlid: string;
  /** The assigned rider's user ulid, once a delivery exists. */
  riderUlid: string | null;
}

/** DB lookups the authorizer needs; backed by Knex in production, faked in tests. */
export interface RealtimeResolver {
  orderParticipants(orderUlid: string): Promise<OrderParticipants | null>;
  merchantStaffUlids(merchantUlid: string): Promise<string[]>;
}

export type RoomKind = 'order' | 'rider' | 'merchant';

export interface ParsedRoom {
  kind: RoomKind;
  id: string;
}

/** Parse a `kind:id` room name; returns null for anything unrecognised. */
export function parseRoom(room: string): ParsedRoom | null {
  const idx = room.indexOf(':');
  if (idx <= 0 || idx === room.length - 1) {
    return null;
  }
  const kind = room.slice(0, idx);
  const id = room.slice(idx + 1);
  if (kind === 'order' || kind === 'rider' || kind === 'merchant') {
    return { kind, id };
  }
  return null;
}

function isAdmin(principal: RealtimePrincipal): boolean {
  return principal.roles.includes('admin') || principal.roles.includes('ops');
}

/** Decide whether `principal` may join `room` (same ownership rules as the REST layer). */
export async function authorizeJoin(
  principal: RealtimePrincipal,
  room: string,
  resolver: RealtimeResolver,
): Promise<boolean> {
  const parsed = parseRoom(room);
  if (!parsed) {
    return false;
  }

  if (parsed.kind === 'rider') {
    return principal.roles.includes('rider') && principal.ulid === parsed.id;
  }

  if (parsed.kind === 'merchant') {
    if (isAdmin(principal)) {
      return true;
    }
    const staff = await resolver.merchantStaffUlids(parsed.id);
    return staff.includes(principal.ulid);
  }

  // order room
  if (isAdmin(principal)) {
    return true;
  }
  const participants = await resolver.orderParticipants(parsed.id);
  if (!participants) {
    return false;
  }
  if (principal.ulid === participants.customerUlid || principal.ulid === participants.riderUlid) {
    return true;
  }
  const staff = await resolver.merchantStaffUlids(participants.merchantUlid);
  return staff.includes(principal.ulid);
}
