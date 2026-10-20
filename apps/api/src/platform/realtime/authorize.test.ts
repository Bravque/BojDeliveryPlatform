import { describe, expect, it } from 'vitest';
import { authorizeJoin, parseRoom, type RealtimeResolver } from './authorize';

const resolver: RealtimeResolver = {
  orderParticipants: (ulid) =>
    Promise.resolve(
      ulid === 'ORD1' ? { customerUlid: 'CUST', merchantUlid: 'MERCH', riderUlid: 'RIDER' } : null,
    ),
  merchantStaffUlids: (ulid) => Promise.resolve(ulid === 'MERCH' ? ['STAFF', 'OWNER'] : []),
};

const p = (ulid: string, roles: string[] = []) => ({ ulid, roles });

describe('parseRoom', () => {
  it('parses the three known room kinds', () => {
    expect(parseRoom('order:ORD1')).toEqual({ kind: 'order', id: 'ORD1' });
    expect(parseRoom('rider:R1')).toEqual({ kind: 'rider', id: 'R1' });
    expect(parseRoom('merchant:M1')).toEqual({ kind: 'merchant', id: 'M1' });
  });

  it('rejects unknown/malformed rooms', () => {
    expect(parseRoom('ledger:1')).toBeNull();
    expect(parseRoom('order:')).toBeNull();
    expect(parseRoom(':ORD1')).toBeNull();
    expect(parseRoom('nope')).toBeNull();
  });
});

describe('authorizeJoin — order room', () => {
  it('allows admin/ops, the customer, the assigned rider, and merchant staff', async () => {
    expect(await authorizeJoin(p('anyone', ['admin']), 'order:ORD1', resolver)).toBe(true);
    expect(await authorizeJoin(p('anyone', ['ops']), 'order:ORD1', resolver)).toBe(true);
    expect(await authorizeJoin(p('CUST', ['customer']), 'order:ORD1', resolver)).toBe(true);
    expect(await authorizeJoin(p('RIDER', ['rider']), 'order:ORD1', resolver)).toBe(true);
    expect(await authorizeJoin(p('STAFF', ['merchant_staff']), 'order:ORD1', resolver)).toBe(true);
  });

  it('denies a stranger and an unknown order', async () => {
    expect(await authorizeJoin(p('STRANGER', ['customer']), 'order:ORD1', resolver)).toBe(false);
    expect(await authorizeJoin(p('CUST', ['customer']), 'order:NOPE', resolver)).toBe(false);
  });
});

describe('authorizeJoin — rider room', () => {
  it('allows only the rider themselves', async () => {
    expect(await authorizeJoin(p('R1', ['rider']), 'rider:R1', resolver)).toBe(true);
    expect(await authorizeJoin(p('R2', ['rider']), 'rider:R1', resolver)).toBe(false);
    expect(await authorizeJoin(p('R1', ['customer']), 'rider:R1', resolver)).toBe(false);
    // admin does not join a rider's personal room.
    expect(await authorizeJoin(p('A', ['admin']), 'rider:R1', resolver)).toBe(false);
  });
});

describe('authorizeJoin — merchant room', () => {
  it('allows admin/ops and staff of that merchant, denies others', async () => {
    expect(await authorizeJoin(p('A', ['admin']), 'merchant:MERCH', resolver)).toBe(true);
    expect(await authorizeJoin(p('STAFF', ['merchant_staff']), 'merchant:MERCH', resolver)).toBe(
      true,
    );
    expect(await authorizeJoin(p('STAFF', ['merchant_staff']), 'merchant:OTHER', resolver)).toBe(
      false,
    );
    expect(await authorizeJoin(p('STRANGER', ['merchant_owner']), 'merchant:MERCH', resolver)).toBe(
      false,
    );
  });
});

describe('authorizeJoin — malformed', () => {
  it('denies an unparseable room', async () => {
    expect(await authorizeJoin(p('A', ['admin']), 'bogus', resolver)).toBe(false);
  });
});
