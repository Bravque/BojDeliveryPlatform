import type { AuditEntry, AuditLogRecord, AuditRepo } from './repo';

/**
 * Append-only audit trail (doc 06 §4). Sensitive actions (role grants, refund/payout approvals,
 * forced transitions) call `record()` with actor + before/after; later phases wire it into those
 * mutations. `listRecent()` backs the admin audit view and is role-gated at the route.
 */
export function createAuditService(repo: AuditRepo) {
  /** Append an audit entry. Fields default to nulls so callers only pass what they have. */
  function record(
    entry: Partial<AuditEntry> & Pick<AuditEntry, 'action' | 'entityType'>,
  ): Promise<void> {
    return repo.insertAuditLog({
      actorUserId: entry.actorUserId ?? null,
      actorRole: entry.actorRole ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      ip: entry.ip ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
  }

  function listRecent(limit = 50): Promise<AuditLogRecord[]> {
    return repo.listRecentAuditLogs(Math.min(Math.max(limit, 1), 200));
  }

  return { record, listRecent };
}

export type AuditService = ReturnType<typeof createAuditService>;
