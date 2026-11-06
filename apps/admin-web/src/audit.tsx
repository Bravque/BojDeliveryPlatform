import { useCallback, useEffect, useState } from 'react';
import type { ApiClient, AuditLogEntry } from './api';
import { formatDateTime, titleCase } from './format';
import { Badge, Button, EmptyState, Spinner } from './ui';

/**
 * Audit log view — the most recent appended audit entries (actor, action, entity, time). Read-only;
 * the server caps the window. A refresh re-reads the trail.
 */
export function AuditView({ api, token }: { api: ApiClient; token: string }): JSX.Element {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setEntries(await api.listAuditLogs(token));
    } catch {
      setError('Failed to load the audit log.');
    } finally {
      setBusy(false);
      setLoading(false);
    }
  }, [api, token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <Spinner />;
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Audit log</h2>
          <p className="page-head__sub">Most recent back-office actions</p>
        </div>
        <div className="page-head__actions">
          <Button variant="ghost" small disabled={busy} onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {entries && entries.length === 0 ? (
        <EmptyState>No audit entries yet.</EmptyState>
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                </tr>
              </thead>
              <tbody>
                {entries?.map((e) => (
                  <tr key={e.id} data-testid={`audit-${e.id}`}>
                    <td>{formatDateTime(e.createdAt)}</td>
                    <td>
                      {e.actorRole ? (
                        <Badge tone="info">{titleCase(e.actorRole)}</Badge>
                      ) : (
                        <span className="muted">system</span>
                      )}
                      {e.actorUserId !== null && <span className="muted"> #{e.actorUserId}</span>}
                    </td>
                    <td className="table__mono">{e.action}</td>
                    <td>
                      {titleCase(e.entityType)}
                      {e.entityId !== null && <span className="muted"> #{e.entityId}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
