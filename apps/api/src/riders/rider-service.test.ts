import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../auth/repo';
import { createRiderService, type Actor } from './rider-service';
import type {
  RiderEarnings,
  RiderListRow,
  RiderRecord,
  RiderRepo,
  RiderStatus,
  VehicleType,
} from './repo';

class FakeRiderRepo implements RiderRepo {
  private readonly usersByUlid = new Map<string, number>();
  private readonly ulidByUserId = new Map<number, string>();
  private readonly phonesByUserId = new Map<number, string>();
  readonly riders: RiderRecord[] = [];
  readonly globalRoles: { userId: number; roleCode: string }[] = [];
  readonly earningsByUser = new Map<number, RiderEarnings>();

  addUser(ulid: string, id: number, phoneE164?: string): void {
    this.usersByUlid.set(ulid, id);
    this.ulidByUserId.set(id, ulid);
    if (phoneE164 !== undefined) {
      this.phonesByUserId.set(id, phoneE164);
    }
  }

  findUserIdByUlid(ulid: string): Promise<number | null> {
    return Promise.resolve(this.usersByUlid.get(ulid) ?? null);
  }
  createRiderProfile(input: { userId: number; vehicleType: VehicleType }): Promise<RiderRecord> {
    const r: RiderRecord = {
      userId: input.userId,
      userUlid: this.ulidByUserId.get(input.userId) ?? `U${input.userId}`,
      status: 'pending',
      vehicleType: input.vehicleType,
      isOnline: false,
      lastLat: null,
      lastLng: null,
      lastPingAt: null,
      ratingAvg: null,
      payoutPhoneE164: null,
    };
    this.riders.push(r);
    return Promise.resolve(r);
  }
  findRiderByUserUlid(ulid: string): Promise<RiderRecord | null> {
    return Promise.resolve(this.riders.find((r) => r.userUlid === ulid) ?? null);
  }
  findRiderByUserId(userId: number): Promise<RiderRecord | null> {
    return Promise.resolve(this.riders.find((r) => r.userId === userId) ?? null);
  }
  setRiderStatus(userId: number, status: RiderStatus): Promise<void> {
    const r = this.riders.find((x) => x.userId === userId);
    if (r) {
      r.status = status;
    }
    return Promise.resolve();
  }
  grantGlobalRole(userId: number, roleCode: string): Promise<void> {
    this.globalRoles.push({ userId, roleCode });
    return Promise.resolve();
  }
  setOnline(userId: number, isOnline: boolean): Promise<void> {
    const r = this.riders.find((x) => x.userId === userId);
    if (r) {
      r.isOnline = isOnline;
    }
    return Promise.resolve();
  }
  recordPing(userId: number, lat: number, lng: number): Promise<void> {
    const r = this.riders.find((x) => x.userId === userId);
    if (r) {
      r.lastLat = lat;
      r.lastLng = lng;
      r.lastPingAt = new Date();
    }
    return Promise.resolve();
  }
  setPayoutPhone(userId: number, phoneE164: string | null): Promise<void> {
    const r = this.riders.find((x) => x.userId === userId);
    if (r) {
      r.payoutPhoneE164 = phoneE164;
    }
    return Promise.resolve();
  }
  getEarnings(userId: number): Promise<RiderEarnings> {
    return Promise.resolve(
      this.earningsByUser.get(userId) ?? { deliveries: 0, totalEarnedCents: 0 },
    );
  }
  listRiders(): Promise<RiderListRow[]> {
    // Newest first, mirroring the Knex `order by created_at desc`.
    return Promise.resolve(
      [...this.riders].reverse().map((r) => ({
        ...r,
        phoneE164: this.phonesByUserId.get(r.userId) ?? null,
        createdAt: new Date(),
      })),
    );
  }
}

const ADMIN: Actor = { ulid: 'ADMIN-ULID', roles: ['admin'] };
const APPLICANT: Actor = { ulid: 'APPLICANT-ULID', roles: ['customer'] };

function setup() {
  const repo = new FakeRiderRepo();
  repo.addUser('ADMIN-ULID', 99);
  repo.addUser('APPLICANT-ULID', 42);
  const recorded: Partial<AuditEntry>[] = [];
  const auditService = {
    record: (e: Partial<AuditEntry> & Pick<AuditEntry, 'action' | 'entityType'>) => {
      recorded.push(e);
      return Promise.resolve();
    },
    listRecent: () => Promise.resolve([]),
  };
  const svc = createRiderService({ repo, auditService });
  return { repo, svc, recorded };
}

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

describe('rider onboarding service', () => {
  it('creates a pending rider on apply and audits it', async () => {
    const { svc, repo, recorded } = setup();
    const r = await svc.applyAsRider(APPLICANT, { vehicleType: 'motorbike' });
    expect(r.status).toBe('pending');
    expect(r.vehicleType).toBe('motorbike');
    expect(repo.riders).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      action: 'rider.apply',
      entityType: 'rider',
      actorUserId: 42,
    });
  });

  it('rejects a second application from the same user with 409', async () => {
    const { svc } = setup();
    await svc.applyAsRider(APPLICANT, { vehicleType: 'bicycle' });
    expect(await thrownStatus(svc.applyAsRider(APPLICANT, { vehicleType: 'car' }))).toBe(409);
  });

  it('rejects an application from an unknown principal with 401', async () => {
    const { svc } = setup();
    expect(
      await thrownStatus(svc.applyAsRider({ ulid: 'ghost', roles: [] }, { vehicleType: 'foot' })),
    ).toBe(401);
  });

  it('approves a rider: status approved + grants the rider role + audits', async () => {
    const { svc, repo, recorded } = setup();
    await svc.applyAsRider(APPLICANT, { vehicleType: 'motorbike' });
    const approved = await svc.approveRider(ADMIN, 'APPLICANT-ULID');
    expect(approved.status).toBe('approved');
    expect(repo.globalRoles).toContainEqual({ userId: 42, roleCode: 'rider' });
    expect(recorded.at(-1)).toMatchObject({ action: 'rider.approve' });
  });

  it('suspends a rider', async () => {
    const { svc } = setup();
    await svc.applyAsRider(APPLICANT, { vehicleType: 'motorbike' });
    const suspended = await svc.suspendRider(ADMIN, 'APPLICANT-ULID', 'documents expired');
    expect(suspended.status).toBe('suspended');
  });

  it('returns 404 approving/suspending an unknown rider', async () => {
    const { svc } = setup();
    expect(await thrownStatus(svc.approveRider(ADMIN, 'nope'))).toBe(404);
    expect(await thrownStatus(svc.suspendRider(ADMIN, 'nope', 'x'))).toBe(404);
  });

  it('returns the own profile, 404 when none exists', async () => {
    const { svc } = setup();
    expect(await thrownStatus(svc.getOwnRider(APPLICANT))).toBe(404);
    await svc.applyAsRider(APPLICANT, { vehicleType: 'car' });
    const me = await svc.getOwnRider(APPLICANT);
    expect(me.vehicleType).toBe('car');
  });

  it('returns the rider’s own earnings', async () => {
    const { svc, repo } = setup();
    repo.earningsByUser.set(42, { deliveries: 3, totalEarnedCents: 21_000 });
    const earnings = await svc.getOwnEarnings(APPLICANT);
    expect(earnings).toEqual({ deliveries: 3, totalEarnedCents: 21_000 });
  });

  it('sets a payout destination (normalises to E.164) and reflects it in the profile', async () => {
    const { svc, recorded } = setup();
    await svc.applyAsRider(APPLICANT, { vehicleType: 'motorbike' });
    const updated = await svc.setPayoutDestination(APPLICANT, '0712345678');
    expect(updated.payoutPhoneE164).toBe('+254712345678');
    expect((await svc.getOwnRider(APPLICANT)).payoutPhoneE164).toBe('+254712345678');
    expect(recorded.at(-1)).toMatchObject({ action: 'rider.payout_destination.set' });
  });

  it('rejects an invalid payout phone with 400, and 404 when not a rider', async () => {
    const { svc } = setup();
    await svc.applyAsRider(APPLICANT, { vehicleType: 'motorbike' });
    expect(await thrownStatus(svc.setPayoutDestination(APPLICANT, 'not-a-phone'))).toBe(400);
    expect(await thrownStatus(svc.setPayoutDestination(ADMIN, '0712345678'))).toBe(404);
  });

  it('lists riders newest-first with phone, status, and ISO createdAt', async () => {
    const { svc, repo } = setup();
    repo.addUser('APPLICANT-ULID', 42, '+254712345678');
    repo.addUser('RIDER2-ULID', 43, '+254700000043');
    await svc.applyAsRider(APPLICANT, { vehicleType: 'motorbike' });
    await svc.applyAsRider(
      { ulid: 'RIDER2-ULID', roles: ['customer'] },
      { vehicleType: 'bicycle' },
    );
    await svc.approveRider(ADMIN, 'APPLICANT-ULID');

    const items = await svc.listRiders();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      userUlid: 'RIDER2-ULID',
      vehicleType: 'bicycle',
      status: 'pending',
      phoneE164: '+254700000043',
    });
    expect(items[1]).toMatchObject({
      userUlid: 'APPLICANT-ULID',
      status: 'approved',
      phoneE164: '+254712345678',
    });
    expect(typeof items[0]?.createdAt).toBe('string');
  });
});
