import { forbidden } from '../http/errors';

/**
 * RBAC policy layer (doc 06 §3). Authorization is always two checks: a **role gate** (does the
 * principal hold a permitted role?) and, where relevant, a **resource ownership** check (does
 * the principal own / relate to *this* resource?). Both are enforced server-side; the UI is
 * never the enforcement point. Concrete domain resources arrive in later phases — this layer is
 * the reusable skeleton they plug into.
 */

export type Role =
  'customer' | 'rider' | 'merchant_owner' | 'merchant_staff' | 'admin' | 'ops' | 'finance';

export interface PolicyPrincipal {
  ulid: string;
  roles: string[];
}

export type Action =
  | 'order:read'
  | 'order:cancel'
  | 'catalogue:write'
  | 'delivery:act'
  | 'refund:approve'
  | 'settlement:approve'
  | 'payout:approve'
  | 'audit:read'
  | 'config:write';

/**
 * Fields an ownership predicate may consult. A resource populates the ones relevant to it
 * (e.g. an order sets `ownerUlid`; a delivery sets `assignedRiderUlid`).
 */
export interface ResourceContext {
  ownerUlid?: string;
  staffUlids?: string[];
  assignedRiderUlid?: string | null;
}

interface PolicyRule {
  /** Roles allowed regardless of ownership. */
  allowAny?: Role[];
  /** Roles allowed only when `owns` returns true for the given resource. */
  allowOwn?: Role[];
  owns?: (principal: PolicyPrincipal, resource: ResourceContext) => boolean;
}

const RULES: Record<Action, PolicyRule> = {
  'order:read': {
    allowAny: ['admin', 'ops'],
    allowOwn: ['customer', 'rider', 'merchant_owner', 'merchant_staff'],
    owns: (p, r) =>
      r.ownerUlid === p.ulid ||
      r.assignedRiderUlid === p.ulid ||
      (r.staffUlids?.includes(p.ulid) ?? false),
  },
  'order:cancel': {
    allowAny: ['admin', 'ops'],
    allowOwn: ['customer'],
    owns: (p, r) => r.ownerUlid === p.ulid,
  },
  'catalogue:write': {
    allowAny: ['admin'],
    allowOwn: ['merchant_owner', 'merchant_staff'],
    owns: (p, r) => r.staffUlids?.includes(p.ulid) ?? false,
  },
  'delivery:act': {
    allowAny: ['admin', 'ops'],
    allowOwn: ['rider'],
    owns: (p, r) => r.assignedRiderUlid === p.ulid,
  },
  'refund:approve': { allowAny: ['admin', 'finance'] },
  'settlement:approve': { allowAny: ['admin', 'finance'] },
  'payout:approve': { allowAny: ['admin', 'finance'] },
  'audit:read': { allowAny: ['admin', 'ops', 'finance'] },
  'config:write': { allowAny: ['admin'] },
};

/** Decide whether `principal` may perform `action` on `resource` (role gate + ownership). */
export function can(
  principal: PolicyPrincipal,
  action: Action,
  resource?: ResourceContext,
): boolean {
  const rule = RULES[action];
  const roles = new Set(principal.roles);

  if (rule.allowAny?.some((role) => roles.has(role))) {
    return true;
  }
  if (rule.allowOwn && rule.owns && resource && rule.allowOwn.some((role) => roles.has(role))) {
    return rule.owns(principal, resource);
  }
  return false;
}

/** Throw a 403 unless `principal` may perform `action` on `resource`. */
export function authorize(
  principal: PolicyPrincipal,
  action: Action,
  resource?: ResourceContext,
): void {
  if (!can(principal, action, resource)) {
    throw forbidden();
  }
}

/**
 * Separation of duties (doc 06 §3.3): the principal who requested a sensitive action (refund /
 * payout) may not be the one who approves it.
 */
export function assertDifferentActor(requesterUlid: string, approverUlid: string): void {
  if (requesterUlid === approverUlid) {
    throw forbidden('Separation of duties: the requester cannot approve their own request');
  }
}
