# BojDeliveryPlatform

A multi-category delivery platform for the Kenyan market (launch town: **Migori**).
Inspired by Uber Eats and Glovo. Built as a modular monorepo.

> **Status: Phase 0 — Foundations & Scaffolding.** The architecture is documented and
> approved; application features are built in reviewable phases. See
> [`docs/architecture`](docs/architecture/00-index.md) and the
> [decision log](docs/architecture/decisions/decision-log.md).

## Applications & packages

| Path | Description |
|------|-------------|
| `apps/api` | Backend API — Node.js, Express, TypeScript, Knex/MySQL |
| `packages/config` | Zod-validated environment configuration helpers |
| `packages/money` | Integer-cents (KES) money utilities |
| `db` *(per app)* | Versioned SQL migrations (`apps/api/db/migrations`) |
| `docs/architecture` | Product, architecture, data model, decisions, phases |

Customer/rider mobile apps and merchant/admin dashboards arrive in later phases.

## Prerequisites

- **Node.js 20** (`.nvmrc` pins the major version)
- **pnpm 9** — `corepack enable pnpm` (or install pnpm 9 manually)
- **Docker** (optional, for local MySQL/Redis/MinIO via `docker-compose.yml`)

## Getting started

```bash
# 1. Install dependencies
pnpm install

# 2. Build the workspace packages once before running them.
#    @boj/config (and @boj/money) compile to dist/, which knexfile.ts and the API
#    import at runtime. A fresh clone must build first, or `pnpm db:migrate` and the
#    dev server fail with "Cannot find module .../@boj/config/dist/index.js".
pnpm build

# 3. Create your local env file
cp .env.example .env

# 4. (optional) start local infrastructure
docker compose up -d

# 5. Run database migrations (requires a reachable MySQL from DATABASE_URL)
pnpm db:migrate

# 6. (optional) load synthetic dev data (inactive Migori town + CBD zone)
pnpm db:seed

# 7. Start the API in watch mode
pnpm --filter @boj/api dev
# -> GET http://localhost:4000/health
```

## Common scripts (run from the repo root)

| Command | What it does |
|---------|--------------|
| `pnpm lint` | ESLint across the workspace |
| `pnpm typecheck` | TypeScript type-check (via Turborepo) |
| `pnpm test` | Unit/integration tests (Vitest, via Turborepo) |
| `pnpm build` | Build all packages/apps |
| `pnpm verify` | lint + typecheck + test + build (the CI gate) |
| `pnpm format` / `pnpm format:check` | Prettier write / check |
| `pnpm db:migrate` / `pnpm db:rollback` | Apply / revert migrations |
| `pnpm db:make <name>` | Scaffold a new migration |
| `pnpm db:status` | Show migration status |
| `pnpm db:seed` | Load synthetic dev data (idempotent; seeds an inactive Migori town + CBD zone) |

## Engineering rules

See [`CLAUDE.md`](CLAUDE.md). In short: TypeScript everywhere; the backend is the source of
truth for prices, commissions, fees and payment status; money is integer cents with a
double-entry ledger; critical order/payment operations are transactional and idempotent;
never commit secrets or real personal data; nothing is "done" until tested.
