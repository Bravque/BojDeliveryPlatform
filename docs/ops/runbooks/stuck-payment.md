# Runbook — Stuck payment (stale `payment_pending`)

**Symptom:** an order sits in `payment_pending` and never moves to paid/`placed` or
`payment_failed`; customer may report being charged. Usually a missed/late STK callback.

**Normal defence:** the scheduler's reconcile sweep handles this automatically when
`SCHEDULER_ENABLED=true` (queries open payments older than `RECONCILE_OLDER_THAN_SEC` every
`RECONCILE_INTERVAL_SEC`, calls Daraja `queryStkStatus`, then idempotently captures or fails).
This runbook is for when the scheduler is off, lagging, or you need to force it now.

## Diagnose

1. Pull the read-only divergence view:
   ```
   GET /api/v1/admin/payments/reconciliation-report      (auth: admin/ops)
   ```
   It lists pending/divergent payments and any amount-mismatch quarantines.
2. Confirm the scheduler is running on exactly one instance (`scheduler-and-redis.md`).

## Remediate

Force a reconcile sweep (idempotent — safe to repeat; a replayed success captures once):
```
POST /api/v1/admin/payments/reconcile        (auth: admin/ops)
```
This runs `reconcileStalePayments(cutoff)`: for each open payment it queries Daraja status and
routes through the same `processStkResult` path as the live webhook — success → ledger capture +
order `placed`/paid; failure → `payment_failed` + stock released; **amount mismatch → quarantined,
not captured** (escalate to `reconciliation-mismatch.md`).

## Verify

- Re-run `GET …/reconciliation-report`; the payment should no longer be listed as open.
- Order moved to `placed`/paid or `payment_failed`; ledger stays balanced
  (`GET /api/v1/admin/reports/ledger`, imbalance flag false).

## Escalate

- Daraja status query itself failing (OAuth/5xx) → `daraja-cutover.md` config checks.
- Payment captured but customer disputes amount → quarantine path →
  `reconciliation-mismatch.md`; do not hand-edit the ledger.
