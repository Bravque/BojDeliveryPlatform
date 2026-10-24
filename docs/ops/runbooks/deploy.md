# Runbook — Deploy & rollback

**Audience:** release engineer / on-call. **Scope:** `apps/api` (and dashboards) to staging/prod.
See `docs/architecture/10-deployment-and-dr.md` §4–5.

## Preconditions

- All 3 required CI checks green on the merge commit (`Lint, typecheck, test, build` ·
  `Migration up/down against MySQL` · `Integration tests against MySQL`).
- Image built and tagged by commit SHA.
- Target env config present in the **secret manager** (never in the repo): `DATABASE_URL`,
  `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY`, `OTP_PEPPER`, `PAYMENT_PROVIDER` (+ `DARAJA_*` when
  Daraja — see `daraja-cutover.md`), HTTP-hardening vars (`CORS_ALLOWED_ORIGINS`, `TRUST_PROXY`,
  `RATE_LIMIT_*`, `AUTH_RATE_LIMIT_MAX`), and scheduler/Redis vars if used
  (`scheduler-and-redis.md`). The service refuses to boot on missing/invalid config (zod).

## Deploy (rolling)

1. **Migrate first (gated pre-deploy step).** Run migrations under the migration DB role
   **before** rolling the app:
   ```bash
   DATABASE_URL="…" pnpm db:migrate      # knex migrate:latest
   DATABASE_URL="…" pnpm db:status       # confirm no pending migrations
   ```
   Migrations are forward-only and backward-compatible (expand/contract), so the previous app
   version keeps working during the roll.
2. **Roll the app** to the new image (rolling / one instance at a time behind the LB).
3. **Post-deploy checks:** `GET /health` returns 200 on each instance; error rate and p95 latency
   steady; payment funnel + reconciliation-mismatch metrics nominal (DR doc §8).
4. **Scheduler:** ensure `SCHEDULER_ENABLED=true` on **exactly one** instance only
   (`scheduler-and-redis.md`).

## Rollback

- **App:** redeploy the previous image tag. Stateless tier → safe to swap.
- **Migration:** never roll back a destructive migration under load. Because changes use
  expand/contract (add now, remove in a later release), the previous image runs against the new
  schema — so an app rollback needs no schema undo. Only use `pnpm db:rollback` for a bad
  **additive** migration caught immediately, before dependent writes exist.

## Verify

- `GET /health` 200 on all instances; smoke a login + a public browse (`GET /api/v1/merchants`).
- No spike in 5xx, ledger-imbalance alerts, or reconciliation mismatches after 10–15 min.

## Escalate

- Migration failure → halt the roll, keep the previous image serving, page the DB owner.
- Boot-config validation failure → fix the secret-manager value; do not patch in the container.
