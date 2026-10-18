# ADR-0001 — Data access layer: Knex over Prisma

- **Status:** Accepted (2026-10-17)
- **Context phase:** Phase 0
- **Decision owner:** Senior engineer, endorsed in architecture review
- **Supersedes / relates to:** `02-system-architecture.md` §7 (previously "open decision")

## Context

The platform's correctness hinges on financial and order integrity: a double-entry ledger,
pessimistic row locking (`SELECT … FOR UPDATE`) for stock reservation and rider-assignment
accept, explicit multi-statement transactions, `CHECK`/`UNIQUE` constraints as safety nets,
and MySQL **spatial (`GEOMETRY`, SRID 4326)** columns for delivery-zone resolution. The
architecture review mandates **reviewed SQL migrations with explicit constraints** as a
first-class artifact and asked for a recommendation between Prisma and Knex based on:
migration safety, transaction support, maintainability, and developer workflow.

## Options considered

### Option A — Prisma
- **Pros:** excellent generated types and autocomplete; ergonomic client; large ecosystem;
  good DX for straightforward CRUD.
- **Cons:**
  - Migrations are generated from a declarative `schema.prisma`; the exact emitted SQL
    (constraints, indexes, check constraints, generated columns) is a derived artifact rather
    than the hand-authored, reviewed contract the review requires.
  - `SELECT … FOR UPDATE` / pessimistic locking is not first-class (needs `$queryRaw`),
    which is precisely our hot path (stock reservation, assignment accept).
  - MySQL `GEOMETRY`/spatial types are not natively modeled (`Unsupported(...)` + raw SQL),
    so zone resolution falls back to raw anyway.
  - Interactive transactions exist but add overhead/foot-guns for the long, lock-heavy
    transactions we need; mixing Prisma + raw inside one transaction is awkward.

### Option B — Knex (chosen)
- **Pros:**
  - **Migrations are hand-authored and reviewed** (JS/TS wrapping SQL or raw SQL) — the
    migration *is* the contract, matching the review mandate; `up`/`down` are explicit.
  - **First-class transactions and `.forUpdate()`**, plus trivial drop-to-raw-SQL for the
    ledger, spatial queries, and lock statements — no escape-hatch friction.
  - Full control over constraints, indexes, `CHECK`, spatial indexes, and engine/charset.
  - Mature, stable, minimal magic; predictable SQL.
- **Cons:**
  - Weaker compile-time type safety than Prisma (query results are loosely typed).
  - More boilerplate for plain CRUD.

### Option C — Kysely (noted, not chosen now)
Type-safe SQL query builder; strong types + raw control. Attractive, but introduces a second
tool alongside a migration runner and is less battle-tested for our team right now.

## Decision

Adopt **Knex** for both **migrations** and **query building** in `apps/api`.

To mitigate Knex's main weakness (type safety), we will:
1. Keep repository methods thin and return **explicitly typed DTOs** (hand-written or derived
   from `packages/shared-types`), so loosely-typed query results never leak past the repo.
2. Centralize transaction + `FOR UPDATE` helpers in `platform/db` so locking is consistent.
3. Revisit adding **Kysely** for hot, type-sensitive read queries if the type gap causes
   real defects — additive, no migration-tool change required.

## Consequences

- Migrations live in `apps/api/db/migrations` as reviewed, versioned files; SQL is the
  source of truth (satisfies CLAUDE.md "document database migrations").
- The ledger, stock reservation, and assignment-accept transactions can use `forUpdate()` and
  raw SQL directly, keeping the money/concurrency core correct and explicit.
- Spatial zone resolution uses raw MySQL spatial functions without fighting an ORM.
- We accept more manual typing discipline at the repository boundary; this is enforced by
  code review and the typed-DTO rule.
- `02-system-architecture.md` §7 and `12-open-decisions-and-risks.md` are updated to reflect
  this decision.
