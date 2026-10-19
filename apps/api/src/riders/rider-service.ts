import type { AuditService } from '../auth/audit-service';
import { conflict, notFound, unauthorized } from '../http/errors';
import type { RiderRecord, RiderRepo, VehicleType } from './repo';

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

  return { applyAsRider, approveRider, suspendRider, getOwnRider };
}

export type RiderService = ReturnType<typeof createRiderService>;
