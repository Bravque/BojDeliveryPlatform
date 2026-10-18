import type { AuditService } from '../auth/audit-service';
import { newUlid } from '../auth/crypto';
import { badRequest, notFound } from '../http/errors';
import type { MerchantCategory, MerchantRecord, MerchantRepo } from './repo';

/** The acting principal (from req.principal). Resolved to a DB user id for the audit trail. */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface CreateMerchantInput {
  townName: string;
  name: string;
  categoryType: MerchantCategory;
  commissionBps: number;
  prepMinutes: number;
  ownerUserUlid?: string;
}

export interface MerchantSummary {
  ulid: string;
  name: string;
  categoryType: MerchantCategory;
  status: MerchantRecord['status'];
  isOpen: boolean;
  prepMinutes: number;
  commissionBps: number;
}

export interface MerchantServiceDeps {
  repo: MerchantRepo;
  auditService: AuditService;
}

function toSummary(m: MerchantRecord): MerchantSummary {
  return {
    ulid: m.ulid,
    name: m.name,
    categoryType: m.categoryType,
    status: m.status,
    isOpen: m.isOpen,
    prepMinutes: m.prepMinutes,
    commissionBps: m.commissionBps,
  };
}

export function createMerchantService(deps: MerchantServiceDeps) {
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
      entityType: 'merchant',
      entityId,
      before,
      after,
    });
  }

  async function linkOwner(
    merchant: MerchantRecord,
    userUlid: string,
    role: 'owner' | 'staff',
  ): Promise<void> {
    const userId = await repo.findUserIdByUlid(userUlid);
    if (userId === null) {
      throw badRequest('Unknown user', [{ field: 'ownerUserUlid', issue: 'not found' }]);
    }
    await repo.addMerchantUser(merchant.id, userId, role);
    await repo.grantGlobalRole(userId, role === 'owner' ? 'merchant_owner' : 'merchant_staff');
  }

  async function requireMerchant(ulid: string): Promise<MerchantRecord> {
    const merchant = await repo.findMerchantByUlid(ulid);
    if (!merchant) {
      throw notFound('Merchant not found');
    }
    return merchant;
  }

  async function createMerchant(
    actor: Actor,
    input: CreateMerchantInput,
  ): Promise<MerchantSummary> {
    const townId = await repo.findTownIdByName(input.townName);
    if (townId === null) {
      throw badRequest('Unknown town', [{ field: 'townName', issue: 'not found' }]);
    }
    const merchant = await repo.createMerchant({
      ulid: newUlid(),
      townId,
      name: input.name,
      categoryType: input.categoryType,
      commissionBps: input.commissionBps,
      prepMinutes: input.prepMinutes,
    });
    if (input.ownerUserUlid) {
      await linkOwner(merchant, input.ownerUserUlid, 'owner');
    }
    await audit(actor, 'merchant.create', merchant.id, null, {
      status: merchant.status,
      commissionBps: merchant.commissionBps,
    });
    return toSummary(merchant);
  }

  async function approveMerchant(actor: Actor, merchantUlid: string): Promise<MerchantSummary> {
    const merchant = await requireMerchant(merchantUlid);
    if (merchant.status !== 'approved') {
      await repo.setMerchantStatus(merchant.id, 'approved');
      await audit(
        actor,
        'merchant.approve',
        merchant.id,
        { status: merchant.status },
        {
          status: 'approved',
        },
      );
    }
    return toSummary({ ...merchant, status: 'approved' });
  }

  async function suspendMerchant(
    actor: Actor,
    merchantUlid: string,
    reason: string,
  ): Promise<MerchantSummary> {
    const merchant = await requireMerchant(merchantUlid);
    if (merchant.status !== 'suspended') {
      await repo.setMerchantStatus(merchant.id, 'suspended');
      await audit(
        actor,
        'merchant.suspend',
        merchant.id,
        { status: merchant.status },
        {
          status: 'suspended',
          reason,
        },
      );
    }
    return toSummary({ ...merchant, status: 'suspended' });
  }

  async function addOwner(
    actor: Actor,
    merchantUlid: string,
    userUlid: string,
    role: 'owner' | 'staff',
  ): Promise<MerchantSummary> {
    const merchant = await requireMerchant(merchantUlid);
    await linkOwner(merchant, userUlid, role);
    await audit(actor, 'merchant.owner.add', merchant.id, null, { userUlid, role });
    return toSummary(merchant);
  }

  return { createMerchant, approveMerchant, suspendMerchant, addOwner };
}

export type MerchantService = ReturnType<typeof createMerchantService>;
