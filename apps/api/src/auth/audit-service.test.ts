import { describe, expect, it } from 'vitest';
import { createAuditService } from './audit-service';
import type { AuditEntry, AuditLogRecord, AuditRepo } from './repo';

class FakeAuditRepo implements AuditRepo {
  readonly entries: AuditEntry[] = [];

  insertAuditLog(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }

  listRecentAuditLogs(limit: number): Promise<AuditLogRecord[]> {
    const recent = this.entries.slice(-limit).reverse();
    return Promise.resolve(
      recent.map((e, i) => ({
        id: this.entries.length - i,
        actorUserId: e.actorUserId,
        actorRole: e.actorRole,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        before: e.before,
        after: e.after,
        createdAt: new Date(),
      })),
    );
  }
}

describe('audit service', () => {
  it('records an entry, defaulting the fields the caller omits', async () => {
    const repo = new FakeAuditRepo();
    const svc = createAuditService(repo);

    await svc.record({
      action: 'order.refund.approve',
      entityType: 'order',
      actorUserId: 5,
      actorRole: 'finance',
      after: { amountCents: 100 },
    });

    expect(repo.entries).toHaveLength(1);
    expect(repo.entries[0]).toMatchObject({
      action: 'order.refund.approve',
      entityType: 'order',
      actorUserId: 5,
      actorRole: 'finance',
      entityId: null,
      ip: null,
      before: null,
    });
  });

  it('lists recent entries (clamped limit)', async () => {
    const repo = new FakeAuditRepo();
    const svc = createAuditService(repo);
    await svc.record({ action: 'a', entityType: 't' });
    await svc.record({ action: 'b', entityType: 't' });

    const items = await svc.listRecent(50);
    expect(items).toHaveLength(2);
    expect(items[0]?.action).toBe('b'); // most recent first
  });
});
