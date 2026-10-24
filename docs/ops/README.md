# Operations (Phase 8)

Runbooks, DR/load-test scripts, and go-live checklists for running BojDelivery in production.
These are the **enabling artifacts** for Phase 8 go-live. The real-infra executions they enable
(live Daraja run, 10× load test, restore drill, security/DPA sign-off) are **operator-run** — see
`go-live-checklist.md`. Architecture context: `docs/architecture/10-deployment-and-dr.md`.

## Go-live gate

- **[go-live-checklist.md](go-live-checklist.md)** — the launch gate; maps the four Phase 8
  acceptance criteria to evidence + status, plus explicit go/no-go items.

## Runbooks (`runbooks/`)

| Runbook | Use when |
|---------|----------|
| [deploy.md](runbooks/deploy.md) | Deploying/rolling back the API (migrations gated pre-deploy). |
| [daraja-cutover.md](runbooks/daraja-cutover.md) | Switching payments to real Daraja (sandbox → prod). |
| [stuck-payment.md](runbooks/stuck-payment.md) | A payment is stuck `payment_pending`. |
| [failed-payout.md](runbooks/failed-payout.md) | A B2C payout is `failed`/stuck. |
| [reconciliation-mismatch.md](runbooks/reconciliation-mismatch.md) | Ledger imbalance or Daraja-vs-ledger divergence. |
| [rider-assignment-stall.md](runbooks/rider-assignment-stall.md) | Offers not progressing / no rider assigned. |
| [restore.md](runbooks/restore.md) | Backup + the recorded restore drill. |
| [scheduler-and-redis.md](runbooks/scheduler-and-redis.md) | Enabling the scheduler + Redis socket adapter. |

## Scripts (`/scripts`)

| Script | Purpose |
|--------|---------|
| [`backup-mysql.sh`](../../scripts/backup-mysql.sh) | Consistent gzip + checksummed logical backup from `DATABASE_URL`. |
| [`restore-drill.sh`](../../scripts/restore-drill.sh) | Restore into an isolated DB + migration-status + ledger-invariant checks (operator-run). |
| [`load-test/order-flow.js`](../../scripts/load-test/order-flow.js) | k6 ramp-to-10× load test ([README](../../scripts/load-test/README.md)). |

## Checklists

- **[security-review-checklist.md](security-review-checklist.md)** — requires human review sign-off.
- **[data-protection-dpa-checklist.md](data-protection-dpa-checklist.md)** — Kenya DPA 2019;
  requires DPO/Legal sign-off.

## Known go-live gap

Merchant B2C payout destination is **not modelled** (riders only, via `user.phone_e164`). Resolve
or document a workaround before launch — tracked in `go-live-checklist.md`.
