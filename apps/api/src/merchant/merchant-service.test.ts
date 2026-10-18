import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../auth/repo';
import { createMerchantService, type Actor } from './merchant-service';
import type { CreateMerchantInput, MerchantRecord, MerchantRepo, MerchantUserRole } from './repo';

class FakeMerchantRepo implements MerchantRepo {
  private readonly towns = new Map<string, number>();
  private readonly usersByUlid = new Map<string, number>();
  readonly merchants: MerchantRecord[] = [];
  readonly merchantUsers: { merchantId: number; userId: number; role: MerchantUserRole }[] = [];
  readonly globalRoles: { userId: number; roleCode: string }[] = [];
  private seq = 0;

  addTown(name: string, id: number): void {
    this.towns.set(name, id);
  }
  addUser(ulid: string, id: number): void {
    this.usersByUlid.set(ulid, id);
  }

  findTownIdByName(name: string): Promise<number | null> {
    return Promise.resolve(this.towns.get(name) ?? null);
  }
  findUserIdByUlid(ulid: string): Promise<number | null> {
    return Promise.resolve(this.usersByUlid.get(ulid) ?? null);
  }
  createMerchant(input: CreateMerchantInput): Promise<MerchantRecord> {
    const m: MerchantRecord = {
      id: ++this.seq,
      ulid: input.ulid,
      townId: input.townId,
      name: input.name,
      categoryType: input.categoryType,
      status: 'pending',
      isOpen: false,
      prepMinutes: input.prepMinutes,
      commissionBps: input.commissionBps,
      createdAt: new Date(),
    };
    this.merchants.push(m);
    return Promise.resolve(m);
  }
  findMerchantByUlid(ulid: string): Promise<MerchantRecord | null> {
    return Promise.resolve(this.merchants.find((m) => m.ulid === ulid) ?? null);
  }
  setMerchantStatus(merchantId: number, status: MerchantRecord['status']): Promise<void> {
    const m = this.merchants.find((x) => x.id === merchantId);
    if (m) {
      m.status = status;
    }
    return Promise.resolve();
  }
  addMerchantUser(merchantId: number, userId: number, role: MerchantUserRole): Promise<void> {
    this.merchantUsers.push({ merchantId, userId, role });
    return Promise.resolve();
  }
  grantGlobalRole(userId: number, roleCode: string): Promise<void> {
    this.globalRoles.push({ userId, roleCode });
    return Promise.resolve();
  }
}

const ADMIN: Actor = { ulid: 'ADMIN-ULID', roles: ['admin'] };

function setup() {
  const repo = new FakeMerchantRepo();
  repo.addTown('Migori', 1);
  repo.addUser('ADMIN-ULID', 99);
  const recorded: Partial<AuditEntry>[] = [];
  const auditService = {
    record: (e: Partial<AuditEntry> & Pick<AuditEntry, 'action' | 'entityType'>) => {
      recorded.push(e);
      return Promise.resolve();
    },
    listRecent: () => Promise.resolve([]),
  };
  const svc = createMerchantService({ repo, auditService });
  return { repo, svc, recorded };
}

const baseInput = {
  townName: 'Migori',
  name: 'Joe Kitchen',
  categoryType: 'restaurant' as const,
  commissionBps: 1000,
  prepMinutes: 20,
};

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

describe('merchant onboarding service', () => {
  it('creates a pending merchant and audits it', async () => {
    const { svc, recorded } = setup();
    const m = await svc.createMerchant(ADMIN, baseInput);
    expect(m.status).toBe('pending');
    expect(m.commissionBps).toBe(1000);
    expect(recorded[0]).toMatchObject({
      action: 'merchant.create',
      entityType: 'merchant',
      actorUserId: 99,
      actorRole: 'admin',
    });
  });

  it('rejects an unknown town with 400', async () => {
    const { svc } = setup();
    expect(
      await thrownStatus(svc.createMerchant(ADMIN, { ...baseInput, townName: 'Nairobi' })),
    ).toBe(400);
  });

  it('links an owner on create and grants the merchant_owner global role', async () => {
    const { repo, svc } = setup();
    repo.addUser('OWNER-ULID', 42);
    await svc.createMerchant(ADMIN, { ...baseInput, ownerUserUlid: 'OWNER-ULID' });
    expect(repo.merchantUsers).toContainEqual({ merchantId: 1, userId: 42, role: 'owner' });
    expect(repo.globalRoles).toContainEqual({ userId: 42, roleCode: 'merchant_owner' });
  });

  it('rejects linking an unknown owner with 400', async () => {
    const { svc } = setup();
    expect(
      await thrownStatus(svc.createMerchant(ADMIN, { ...baseInput, ownerUserUlid: 'ghost' })),
    ).toBe(400);
  });

  it('approves a merchant and audits the transition', async () => {
    const { svc, recorded } = setup();
    const created = await svc.createMerchant(ADMIN, baseInput);
    const approved = await svc.approveMerchant(ADMIN, created.ulid);
    expect(approved.status).toBe('approved');
    expect(recorded.at(-1)).toMatchObject({ action: 'merchant.approve' });
  });

  it('suspends a merchant', async () => {
    const { svc } = setup();
    const created = await svc.createMerchant(ADMIN, baseInput);
    const suspended = await svc.suspendMerchant(ADMIN, created.ulid, 'policy violation');
    expect(suspended.status).toBe('suspended');
  });

  it('returns 404 approving/suspending an unknown merchant', async () => {
    const { svc } = setup();
    expect(await thrownStatus(svc.approveMerchant(ADMIN, 'nope'))).toBe(404);
    expect(await thrownStatus(svc.suspendMerchant(ADMIN, 'nope', 'x'))).toBe(404);
  });

  it('adds a staff member and grants the merchant_staff role', async () => {
    const { repo, svc } = setup();
    repo.addUser('STAFF-ULID', 7);
    const created = await svc.createMerchant(ADMIN, baseInput);
    await svc.addOwner(ADMIN, created.ulid, 'STAFF-ULID', 'staff');
    expect(repo.merchantUsers).toContainEqual({ merchantId: 1, userId: 7, role: 'staff' });
    expect(repo.globalRoles).toContainEqual({ userId: 7, roleCode: 'merchant_staff' });
  });
});
