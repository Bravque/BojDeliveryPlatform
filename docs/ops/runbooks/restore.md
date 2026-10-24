# Runbook — Backup & restore drill

**Audience:** ops / DBA. **Scope:** take a logical backup and rehearse a restore into an
**isolated** database, verifying integrity. Satisfies DR acceptance §10: _"a restore drill has
actually been performed and its result recorded."_ See `docs/architecture/10-deployment-and-dr.md`
§6–7.

> In production, the managed MySQL provider's automated daily snapshots + PITR (binlog) are the
> primary mechanism. The scripts below are the portable fallback and the **drill** harness.
> **Operator-run against real infra — never target production with the restore step.**

## Backup

```bash
DATABASE_URL="mysql://user:pass@host:3306/boj_prod" \
  ./scripts/backup-mysql.sh ./backups
# -> ./backups/boj-boj_prod-<UTC-ts>.sql.gz  (+ .sha256)
```
`--single-transaction` (consistent, non-locking), routines/triggers/events included,
`--set-gtid-purged=OFF` (portable). Password is passed via `MYSQL_PWD`, never argv.

## Restore drill (monthly)

Restore the backup into a **throwaway** DB and verify:
```bash
RESTORE_DATABASE_URL="mysql://user:pass@host:3306/boj_restore_drill" \
  ./scripts/restore-drill.sh ./backups/boj-boj_prod-<UTC-ts>.sql.gz
```
The script:
1. Verifies the `.sha256` checksum (if present).
2. Recreates the isolated schema and loads the dump.
3. Confirms the Knex migration ledger is fully applied (`pnpm db:status`, no pending).
4. Runs the **double-entry invariant**: every `ledger_transaction` nets to zero across its
   `ledger_entry` rows (positive `amount_cents` + `direction`). Any imbalance fails the drill.
5. Prints row-count sanity + a timestamped **PASS/FAIL**.

Guardrail: it refuses a `RESTORE_DATABASE_URL` containing `prod`.

## Targets (confirm with the business)

- **RPO ≤ 15 min** (PITR), **RTO ≤ 2 h** for the order/payment path at launch (DR §7, to confirm).

## Record (paste each drill result here)

Keep an append-only log of drills so the acceptance box has evidence:

| Date (UTC) | Backup file | Result | Notes / RTO observed | Operator |
|------------|-------------|--------|----------------------|----------|
| _pending_  | _—_         | _requires execution — operator-run_ | no MySQL on dev box | _—_ |

## Escalate

- Drill FAIL (pending migrations or ledger imbalance in the restored data) → engineering on-call;
  do not promote that backup as recoverable.
- Region outage → restore latest offsite backup into the standby region (DR §7), then record RTO.
