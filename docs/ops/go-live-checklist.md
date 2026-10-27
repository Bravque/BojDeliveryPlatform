# Go-live checklist (Phase 8)

Single gate for production launch. Maps the **four Phase 8 acceptance criteria**
(`docs/architecture/11-delivery-phases-and-acceptance.md`) to their evidence and status.

**Legend:** `[code delivered]` = built + tested in-repo (CI); `[requires execution]` =
operator-run against real infra, **cannot be done on the dev box** (no Safaricom creds, no
deployed env, no managed MySQL/Redis) and must be executed + recorded before launch.

## Phase 8 acceptance

| # | Criterion | Status | Evidence / how |
|---|-----------|--------|----------------|
| 1 | Switching `PAYMENT_PROVIDER` to Daraja requires no changes outside the adapter | `[code delivered]` + `[requires execution]` | Adapters `payments/daraja/` + `payouts/daraja/`; `buildGateway()` selects by `PAYMENT_PROVIDER`; tested vs a fake-Daraja server. **Operator:** run a real sandbox STK + rider B2C per `runbooks/daraja-cutover.md`, then flip prod. |
| 2 | Load test meets latency/throughput targets at 10× launch volume | `[requires execution]` | Harness `scripts/load-test/order-flow.js` (k6, ramps to 10×, thresholds p95<800ms / p99<1.5s / <1% errors). **Operator:** run vs staging, attach the k6 summary. |
| 3 | A real restore drill has been executed and its result recorded | `[requires execution]` | `scripts/backup-mysql.sh` + `scripts/restore-drill.sh` (migration-status + ledger-invariant checks). **Operator:** run monthly, record PASS/FAIL in `runbooks/restore.md` §Record. |
| 4 | Security review + data-protection checklist signed off | `[requires execution]` | `security-review-checklist.md` (human sign-off) + `data-protection-dpa-checklist.md` (DPO/Legal sign-off). |

## Explicit go / no-go items

- [ ] **Merchant B2C payout destination** — **modelled** (`merchant.payout_phone_e164`, migration
      `0023`); set per approved merchant via `POST /api/v1/admin/merchants/:ulid/payout-destination`
      **before its first Daraja payout** (a merchant with none still fails execute with "no
      destination"). (`runbooks/daraja-cutover.md` §4, `runbooks/failed-payout.md`.)
- [ ] Scheduler enabled on **exactly one** instance (`runbooks/scheduler-and-redis.md`).
- [ ] `REDIS_URL` set if running >1 app instance (realtime fan-out).
- [ ] Secrets in the secret manager; `DARAJA_WEBHOOK_IP_ALLOWLIST` set in prod.
- [ ] Backups automated; RPO/RTO confirmed with the business (DR doc §7).
- [ ] Alerts verified for ledger imbalance + reconciliation mismatch (DR doc §8).
- [ ] Rollback rehearsed: `PAYMENT_PROVIDER=simulated` flip + previous-image redeploy
      (`runbooks/deploy.md`, `runbooks/daraja-cutover.md`).

## Operator record

| Item | Date (UTC) | Result | Reference | Operator |
|------|-----------|--------|-----------|----------|
| Sandbox STK + B2C smoke | _pending_ | _—_ | daraja-cutover.md | _—_ |
| 10× load test | _pending_ | _—_ | load-test summary | _—_ |
| Restore drill | _pending_ | _—_ | restore.md §Record | _—_ |
| Security sign-off | _pending_ | _—_ | security-review-checklist.md | _—_ |
| DPA sign-off | _pending_ | _—_ | data-protection-dpa-checklist.md | _—_ |

**Launch is a no-go until every `[requires execution]` row above is executed and recorded.**
