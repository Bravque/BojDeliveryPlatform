import type { AuditService } from '../auth/audit-service';
import { badRequest, conflict, notFound, unauthorized } from '../http/errors';
import { normalizeKenyanPhone } from '../auth/phone';
import type { RiderEarnings, RiderRecord, RiderRepo, VehicleType } from './repo';

/** The acting principal (from req.principal). Resolved to a DB user id for the audit trail. */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface RiderSummary {
  userUlid: string;
  status: RiderRecord['status'];
  vehicleType: VehicleType;
  isOnline: boolean;
  /** M-Pesa withdrawal destination; null = earnings pay out to the sign-in number. */
  payoutPhoneE164: string | null;
}

export interface RiderServiceDeps {
  repo: RiderRepo;
  auditService: AuditService;
}

function toSummary(r: RiderRecord): RiderSummary {
  return {
    userUlid: r.userUlid,
    status: r.status,
    vehicleType: r.vehicleType,
    isOnline: r.isOnline,
    payoutPhoneE164: r.payoutPhoneE164,
  };
}

export function createRiderService(deps: RiderServiceDeps) {
  const { repo, auditService } = deps;

  function actorRole(actor: Actor): string {
    return actor.roles.includes('admin') ? 'admin' : (actor.roles[0] ?? 'unknown');
  }

  async function audit(
    actor: Actor,
    action: string,
    entityId: number,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await auditService.record({
      actorUserId: await repo.findUserIdByUlid(actor.ulid),
      actorRole: actorRole(actor),
      action,
      entityType: 'rider',
      entityId,
      before,
      after,
    });
  }

  async function requireUserId(actor: Actor): Promise<number> {
    const userId = await repo.findUserIdByUlid(actor.ulid);
    if (userId === null) {
      throw unauthorized('Unknown principal');
    }
    return userId;
  }

  async function requireRider(userUlid: string): Promise<RiderRecord> {
    const rider = await repo.findRiderByUserUlid(userUlid);
    if (!rider) {
      throw notFound('Rider not found');
    }
    return rider;
  }

  /** A signed-in user applies to become a rider; the profile starts `pending` for admin review. */
  async function applyAsRider(
    actor: Actor,
    input: { vehicleType: VehicleType },
  ): Promise<RiderSummary> {
    const userId = await requireUserId(actor);
    if (await repo.findRiderByUserId(userId)) {
      throw conflict('RIDER_PROFILE_EXISTS', 'A rider profile already exists for this user');
    }
    const rider = await repo.createRiderProfile({ userId, vehicleType: input.vehicleType });
    await audit(actor, 'rider.apply', userId, null, {
      status: rider.status,
      vehicleType: rider.vehicleType,
    });
    return toSummary(rider);
  }

  /** Admin approves a pending rider → `approved`, granting the global `rider` role. */
  async function approveRider(actor: Actor, userUlid: string): Promise<RiderSummary> {
    const rider = await requireRider(userUlid);
    if (rider.status !== 'approved') {
      await repo.setRiderStatus(rider.userId, 'approved');
      await repo.grantGlobalRole(rider.userId, 'rider');
      await audit(
        actor,
        'rider.approve',
        rider.userId,
        { status: rider.status },
        { status: 'approved' },
      );
    }
    return toSummary({ ...rider, status: 'approved' });
  }

  /** Admin suspends a rider (keeps the profile; revocation of live work is handled by assignment). */
  async function suspendRider(
    actor: Actor,
    userUlid: string,
    reason: string,
  ): Promise<RiderSummary> {
    const rider = await requireRider(userUlid);
    if (rider.status !== 'suspended') {
      await repo.setRiderStatus(rider.userId, 'suspended');
      await audit(
        actor,
        'rider.suspend',
        rider.userId,
        { status: rider.status },
        { status: 'suspended', reason },
      );
    }
    return toSummary({ ...rider, status: 'suspended' });
  }

  /** The caller's own rider profile (available to a pending applicant, before the role is granted). */
  async function getOwnRider(actor: Actor): Promise<RiderSummary> {
    const userId = await requireUserId(actor);
    const rider = await repo.findRiderByUserId(userId);
    if (!rider) {
      throw notFound('Rider profile not found');
    }
    return toSummary(rider);
  }

  /** The caller's lifetime earnings from completed deliveries (Σ rider fee over `delivered`). */
  async function getOwnEarnings(actor: Actor): Promise<RiderEarnings> {
    const userId = await requireUserId(actor);
    return repo.getEarnings(userId);
  }

  /** The rider sets their own M-Pesa withdrawal number (normalised to E.164). */
  async function setPayoutDestination(actor: Actor, phone: string): Promise<RiderSummary> {
    const userId = await requireUserId(actor);
    const rider = await repo.findRiderByUserId(userId);
    if (!rider) {
      throw notFound('Rider profile not found');
    }
    const phoneE164 = normalizeKenyanPhone(phone);
    if (phoneE164 === null) {
      throw badRequest('Invalid phone number', [{ field: 'phone', issue: 'not a Kenyan mobile' }]);
    }
    await repo.setPayoutPhone(userId, phoneE164);
    await audit(
      actor,
      'rider.payout_destination.set',
      userId,
      { payoutPhoneE164: rider.payoutPhoneE164 },
      { payoutPhoneE164: phoneE164 },
    );
    return toSummary({ ...rider, payoutPhoneE164: phoneE164 });
  }

  return {
    applyAsRider,
    approveRider,
    suspendRider,
    getOwnRider,
    getOwnEarnings,
    setPayoutDestination,
  };
}

export type RiderService = ReturnType<typeof createRiderService>;
