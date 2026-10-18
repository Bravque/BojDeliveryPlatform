
# Project Engineering Rules

You are the senior engineer for this project.

## General rules

- Read CLAUDE.md and README.md before making changes.
- Inspect existing files before modifying them.
- Explain your implementation plan before substantial changes.
- Work in small, reviewable increments.
- Never replace working features without explaining why.
- Never claim a feature works unless it has been tested.
- Run relevant tests and report their results.
- Keep documentation and environment examples updated.
- Ask before destructive operations.

## Architecture

- Use TypeScript for new application code.
- Use a modular monorepo.
- Use Node.js and Express for the backend.
- Use MySQL for persistent relational data.
- Use React Native and Expo for mobile apps.
- Use React for merchant and admin dashboards.
- Validate API requests at the server boundary.
- Keep business logic out of UI components.
- Document API contracts and database migrations.

## Security

- Enforce role-based permissions on the backend.
- Never trust client-supplied prices, commissions or payment statuses.
- Verify payment callbacks and handle duplicate events safely.
- Use transactions for critical financial and order operations.
- Never commit credentials or production personal data.
- Validate inputs, limit requests and log security-relevant events.
- Use synthetic data for development and automated tests.

## Delivery workflow

For each task:

1. Inspect the relevant code.
2. Describe the intended changes.
3. Implement the smallest complete change.
4. Run type checks, tests and linting where available.
5. Fix regressions.
6. Summarize changed files and verification results.
7. Identify remaining risks or unfinished work.

---

# Project status, history & roadmap

> **Living section — keep current as work lands.** Authoritative full scope + acceptance:
> `docs/architecture/11-delivery-phases-and-acceptance.md`. Authoritative decisions:
> `docs/architecture/decisions/decision-log.md` + ADRs. Repo:
> https://github.com/Bravque/BojDeliveryPlatform (public).

**Current status (2026-10-18):** **Phase 2 — Catalogue, inventory & merchants** in progress.
Inc 1–3 merged; Inc 4 (inventory + reserve/release, with the concurrency test) in progress; Inc 5
(public browse) pending. **Phases 0–1 complete & merged.** `main` is protected.

## How to resume (workflow + environment)
- **Stack:** pnpm 9 + Turborepo monorepo. `apps/api` = Node/Express + Knex + MySQL;
  `packages/config` (zod env), `packages/money` (integer-cents KES).
- **`main` is protected:** all changes go via a PR; **3 required status checks** must pass —
  `Lint, typecheck, test, build` · `Migration up/down against MySQL` · `Integration tests
  against MySQL`. enforce_admins on; no force-push/deletion. (Relax with `enforce_admins=false`
  via `gh api -X PUT …/branches/main/protection` only if truly needed.)
- **Per-increment loop:** branch `phase-N-<topic>` off `main` → implement (migration + repo +
  service + routes + unit/HTTP tests + a `*.int.test.ts` MySQL integration test) → `pnpm verify`
  + `pnpm format:check` locally → commit → push → open PR → confirm all 3 CI checks green → user
  merges → delete branch → next increment. Explain a plan + key decisions before each phase; keep
  increments small and reviewable; do not start the next phase until the user reviews.
- **DB/integration tests:** no MySQL on the dev box, so `pnpm test:int` self-skips locally and
  real DB/migration/integration runs are proven in CI. To run locally: `DATABASE_URL=… pnpm
  db:migrate && pnpm test:int`.
- **Dev login:** phone-OTP (mock SMS logs the code) or seeded dev admin
  `admin@boj.local` / `DevAdmin!2026` (**DEV ONLY**, never production).

## Delivery phases (scope — ticked as merged)
- [x] **Phase 0 — Foundations & scaffolding** (PR #1): monorepo, CI, config/money, DB+migrations, health, logging.
- [x] **Phase 1 — Identity, roles & authorization** (PRs #2–#6; integration-test CI #7): phone-OTP + dashboard email/password (argon2id, lockout, no enumeration); RS256 access + rotating refresh with reuse detection; `requireAuth`, `/me`; RBAC policy (role + ownership + separation of duties); append-only audit log.
- [ ] **Phase 2 — Catalogue, inventory & merchants** *(in progress)*: ✅ Inc1 merchants + admin onboarding (PR #8). ✅ Inc2 catalogue CRUD + merchant profile + optimistic price lock (PR #9). ✅ Inc3 options & availability (min/max-select) (PR #11). ⬜ Inc4 inventory + reserve/release (concurrency) *(in progress)*. ⬜ Inc5 public browse (approved/open only; town-level filtering).
- [ ] **Phase 3 — Cart, pricing & order creation (no payment)**: cart, `POST /cart/quote`, zone resolution + delivery fee, promotions, `POST /orders` with stock reservation + full price snapshot, order state machine (draft/cancelled).
- [ ] **Phase 4 — Payments (simulated) & ledger**: `PaymentGateway` + `SimulatedGateway`, STK initiate/callback/status, double-entry ledger, idempotency/dedupe, timeouts, reconciliation, refunds.
- [ ] **Phase 5 — Rider onboarding, assignment & delivery**: onboarding/approval, online/offline, candidate selection, time-boxed offers, atomic accept, pickup/deliver with **PIN proof** (D7), earnings accrual.
- [ ] **Phase 6 — Realtime, notifications & client apps (MVP)**: Socket.IO (order/offers/merchant) with room auth, push + SMS, customer/rider/merchant/admin MVP flows.
- [ ] **Phase 7 — Settlements, payouts & admin/reporting**: settlement gen/approval, payout batches (simulated B2C), reconciliation UI, reports, disputes/overrides (audited).
- [ ] **Phase 8 — Production hardening & Daraja go-live**: real Daraja via adapter swap, load/soak, backup restore drill, runbooks, security review, DPA sign-off.

## Merged PR history
| PR | Phase.Inc | Summary |
|----|-----------|---------|
| #1 | 0 | Foundations & scaffolding |
| #2 | 1.1 | Identity schema + crypto/tokens |
| #3 | 1.2 | Phone-OTP + `/api/v1` + error envelope |
| #4 | 1.3 | Refresh rotation + reuse detection, `requireAuth`, `/me` |
| #5 | 1.4 | RBAC policy + ownership + audit |
| #6 | 1.5 | Dashboard email/password login |
| #7 | — | MySQL integration-test CI job |
| #8 | 2.1 | Merchant schema + admin onboarding |
| #9 | 2.2 | Catalogue CRUD + profile + optimistic lock |
| #10 | — | CLAUDE.md living status & roadmap |
| #11 | 2.3 | Product option groups & options |

## Key locked decisions (see decision-log.md / ADRs)
- **Launch (D1):** Migori; zones are configurable DB records; **spatial zone resolution deferred to Phase 3**.
- **Data access:** Knex (ADR-0001). **Money:** integer cents, double-entry ledger; server is the source of truth for all prices/fees/commission.
- **Auth:** RS256 via `jsonwebtoken`; argon2id; MySQL-backed OTP throttling; phone-OTP + dashboard password (**TOTP deferred**).
- **Commission (D2):** server-controlled `commission_bps` per merchant, admin-set.
- **Phase 2:** admin-created merchant onboarding; **town-level** browse filtering; product **optimistic locks** (edits require expected `version`). `category`/`merchant`/`product` carry a public `ulid`.
