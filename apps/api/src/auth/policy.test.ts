import { describe, expect, it } from 'vitest';
import { assertDifferentActor, authorize, can, type PolicyPrincipal } from './policy';

const customer: PolicyPrincipal = { ulid: 'C1', roles: ['customer'] };
const otherCustomer: PolicyPrincipal = { ulid: 'C2', roles: ['customer'] };
const rider: PolicyPrincipal = { ulid: 'R1', roles: ['rider'] };
const staff: PolicyPrincipal = { ulid: 'M1', roles: ['merchant_staff'] };
const admin: PolicyPrincipal = { ulid: 'A1', roles: ['admin'] };
const finance: PolicyPrincipal = { ulid: 'F1', roles: ['finance'] };

function thrownStatus(fn: () => void): number | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { status?: number }).status;
  }
}

describe('policy — role gate', () => {
  it('allows privileged roles regardless of ownership', () => {
    expect(can(admin, 'order:read', { ownerUlid: 'someone-else' })).toBe(true);
    expect(can(finance, 'refund:approve')).toBe(true);
    expect(can(admin, 'audit:read')).toBe(true);
  });

  it('denies roles not granted the action', () => {
    expect(can(customer, 'refund:approve')).toBe(false);
    expect(can(customer, 'audit:read')).toBe(false);
    expect(can(rider, 'catalogue:write', { staffUlids: [] })).toBe(false);
  });
});

describe('policy — ownership', () => {
  it('allows an owner but not a non-owner', () => {
    expect(can(customer, 'order:read', { ownerUlid: 'C1' })).toBe(true);
    expect(can(otherCustomer, 'order:read', { ownerUlid: 'C1' })).toBe(false);
    expect(can(customer, 'order:cancel', { ownerUlid: 'C1' })).toBe(true);
    expect(can(customer, 'order:cancel', { ownerUlid: 'C2' })).toBe(false);
  });

  it('allows only the assigned rider to act on a delivery', () => {
    expect(can(rider, 'delivery:act', { assignedRiderUlid: 'R1' })).toBe(true);
    expect(can(rider, 'delivery:act', { assignedRiderUlid: 'R9' })).toBe(false);
  });

  it('allows merchant staff only on their own merchant', () => {
    expect(can(staff, 'catalogue:write', { staffUlids: ['M1', 'M2'] })).toBe(true);
    expect(can(staff, 'catalogue:write', { staffUlids: ['M2'] })).toBe(false);
  });

  it('denies an ownership-gated action when no resource is supplied (UI is not the gate)', () => {
    expect(can(customer, 'order:read')).toBe(false);
    expect(can(rider, 'delivery:act')).toBe(false);
  });
});

describe('policy — authorize + separation of duties', () => {
  it('authorize throws 403 when denied, passes when allowed', () => {
    expect(thrownStatus(() => authorize(customer, 'refund:approve'))).toBe(403);
    expect(thrownStatus(() => authorize(admin, 'refund:approve'))).toBeUndefined();
  });

  it('forbids approving your own request', () => {
    expect(thrownStatus(() => assertDifferentActor('U1', 'U1'))).toBe(403);
    expect(thrownStatus(() => assertDifferentActor('U1', 'U2'))).toBeUndefined();
  });
});
