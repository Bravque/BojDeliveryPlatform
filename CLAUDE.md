
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

**Current status (2026-10-21):** **Phases 0–6 complete & merged** (Phase 6 realtime+notifications +
`merchant-web` first frontend via PRs #29–#32). **Phase 7 — Settlements, payouts & admin/reporting**
feature-complete (plan locked 2026-10-21 — on-demand generation (period as param, **no scheduler**);
**dual-sign payouts** (finance + ops, distinct users); **simulated M-Pesa B2C, no cash guard**;
ledger stays source of truth): Inc 1 (merchant settlements — `0020_settlements`; `net = gross −
commission − refunds` over delivered non-fully-refunded orders (D14); finance approve;
`settlement:approve` policy) **merged (PR #33)**. Inc 2 (payouts — `0021_payouts`; per approved
settlement (merchant) + delivered rider fees (rider); **dual-sign** finance+ops distinct approvers
before execute; simulated B2C execute→confirm; `paid` posts `DR merchant_payable|rider_payable /
CR mpesa_clearing` (idempotent `payout:{id}`) + marks source settlement paid; `payout:approve`
policy; **D16** recorded) **merged (PR #34)**. Inc 3 (reports — read-only `reports/{repo,
report-service}`; `GET /admin/reports/summary` (GMV, volumes by status, cancel/refund rates, rider
utilization) + `GET /admin/reports/ledger` (per-account natural balances + the ledger-invariant
check); `audit:read`; **no migration**) on `phase-7-reports` (open PR). `main` is protected.
**STOP for user review before Phase 8 (Daraja
go-live & hardening).**

## How to resume (workflow + environment)
- **Stack:** pnpm 9 + Turborepo monorepo. `apps/api` = Node/Express + Knex + MySQL + Socket.IO;
  `apps/merchant-web` = React + Vite + TS (first frontend, Phase 6); `packages/config` (zod env),
  `packages/money` (integer-cents KES).
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
- [x] **Phase 2 — Catalogue, inventory & merchants** *(complete)*: ✅ Inc1 merchants + admin onboarding (PR #8). ✅ Inc2 catalogue CRUD + merchant profile + optimistic price lock (PR #9). ✅ Inc3 options & availability (min/max-select) (PR #11). ✅ Inc4 inventory + reserve/release (concurrency) (PR #12). ✅ Inc5 public browse (approved/open only; town-level filtering) (PR #13).
- [x] **Phase 3 — Cart, pricing & order creation (no payment)** *(complete)*: ✅ Inc1 delivery zones (**circle model**, D13) + customer addresses + zone resolution (PR #14). ✅ Inc2 delivery-fee rules (time-boxed, per-zone) + haversine fee calc (PR #15). ✅ Inc3 cart (single-merchant guard + server-side option validation, references only) (PR #16). ✅ Inc4 `POST /cart/quote` authoritative breakdown + promotions (percentage/fixed/free_delivery, caps/eligibility/limits, out-of-zone 422, never-negative) (PR #17). ✅ Inc5 `POST /orders` (atomic recompute → stock reservation → price/commission snapshot → promotion_redemption) + order state-machine framework + `draft → cancelled`; N-on-1-stock concurrency proven (open PR `phase-3-orders`).
- [ ] **Phase 4 — Payments (simulated) & ledger** *(in progress)*: ✅ Inc1 double-entry ledger foundation (`ledger_account/transaction/entry`, chart of accounts, balanced+idempotent `LedgerService.post`; **D4 platform-funded**) (PR #19). ✅ Inc2 payment initiation + `PaymentGateway`/`SimulatedGateway` (`payment`/`payment_event`, `POST /orders/:ulid/pay` Idempotency-Key → `draft→payment_pending`, `GET /payments/:ulid`) (PR #20). ✅ Inc3 STK capture: `POST /webhooks/mpesa/stk` (token) + admin dev-simulate; `payment_event` dedupe; verified success+amount → ledger capture (D4) + order `placed`+paid; fail → `payment_failed` + release stock; amount-mismatch quarantined; replay 100×→one capture (PR #21). ✅ Inc4 timeouts & reconciliation: stale-pending sweep (`listOpenPayments` `initiated_at` cutoff → gateway `queryStkStatus` → idempotent capture/fail via `processStkResult`), read-only divergence report + ledger-balance invariant (`findImbalancedTransactions`), admin endpoints `POST /admin/payments/reconcile` + `GET /admin/payments/reconciliation-report` (open PR `phase-4-reconcile`; **late-success-after-cancel auto-refund deferred to Inc 5**; no scheduler). ✅ Inc5 refunds: `refund` table (`0015`) + lifecycle `requested→approved→processing→completed` (+`rejected`/`failed`); `POST /orders/:ulid/refunds` (request, Idempotency-Key, amount ≤ net refundable) → `POST /refunds/:ulid/approve|reject` (`refund:approve`, requester≠approver) → `POST /dev/refunds/:ulid/simulate` confirm → `refunds_payable` ledger reversal (full = reverse capture; partial = merchant-borne **D14**) + order `refunded`/`partially_refunded`; late-success-after-cancel → auto-refund; idempotent approve/execute never double-pays (open PR `phase-4-refunds`). **Phase 4 feature-complete → STOP for review before Phase 5.**
- [x] **Phase 5 — Rider onboarding, assignment & delivery** *(complete; PRs #24–#28)*: ✅ Inc1 rider onboarding (`rider_profile` migration `0016`; self-apply `POST /rider/apply` → pending; admin `approve`/`suspend`; approval grants the `rider` global role; `GET /rider/me`) (open PR `phase-5-onboarding`). ✅ Inc2 rider presence (`POST /rider/online|offline|ping`, rider role; throttled ping `RIDER_PING_MIN_INTERVAL_SEC`; approved-only) (open PR `phase-5-presence`). ✅ Inc3 merchant order progression (`POST /merchant/orders/:ulid/accept|preparing|ready|reject`; FOR-UPDATE + state-machine + history; merchant-staff ownership + admin/ops; reject is status-only) (open PR `phase-5-fulfillment`). ✅ Inc4 candidate selection + time-boxed offers + **atomic accept** (`0017_assignment_and_delivery`; `delivery.order_id` UNIQUE backstop; order-row FOR UPDATE → first-wins/409 `OFFER_ALREADY_TAKEN`; `GET /rider/offers`, `POST /rider/offers/:id/accept|decline`, `POST /admin/assignments/tick` expiry+re-offer; **D15** rider fee = config rate/platform margin; `markReady`→offer hook) (open PR `phase-5-assignment`). ✅ Inc5 delivery execution + **PIN proof** (D7) + earnings accrual (`0018_delivery_pin`; rider `POST /rider/deliveries/:ulid/pickup|start|complete`; customer `POST /orders/:ulid/delivery-pin` issues the hashed PIN; `out_for_delivery→delivered` on PIN verify → `DR platform_delivery_income / CR rider_payable` (D15), idempotent; admin `override-complete` audited) (open PR `phase-5-delivery`). **Phase 5 feature-complete → STOP for review before Phase 6.**
- [x] **Phase 6 — Realtime, notifications & client apps (MVP)** *(complete; PRs #29–#32)*: scope = realtime+notifications backend + ONE thin client (`merchant-web`), single-instance sockets (Redis→P8), mock push/SMS adapters, best-effort after-commit emit. ✅ Inc1 Socket.IO gateway + room auth (`platform/realtime/`: handshake `verifyAccessToken`; ulid-keyed rooms `order:{ulid}`/`rider:{ulid}`/`merchant:{ulid}`; `authorizeJoin` RBAC parity; `RealtimeGateway` emit API + no-op default; attached to `http.createServer` in main) (open PR `phase-6-realtime`). ✅ Inc2 domain-event emission → realtime (`platform/events/publisher.ts` `DomainEventPublisher.orderStatusChanged` injected post-commit into capture/fulfillment/assignment/delivery services; fan-out emits `status.changed` to `order:{ulid}` + `order.new`(placed)/`order.updated` to `merchant:{ulid}`; late-bound gateway breaks the main.ts cycle; best-effort after-commit) (open PR `phase-6-events`). ✅ Inc3 notifications (`0019_notifications`: `device`+`notification`; `MockPushProvider`/reuse `SmsProvider`; `NotificationDispatcher` = a `DomainEventPublisher` combined with realtime — placed→merchant push, rider_assigned/delivered→customer, SMS fallback, recorded; `POST /devices`) (open PR `phase-6-notifications`). ✅ Inc4 `merchant-web` thin client — first frontend workspace (`apps/merchant-web`, React+Vite+TS): login (`/auth/password/login`) → `GET /merchant/orders` list → joins `merchant:{ulid}` socket room → `order.new`/`order.updated` nudge re-fetches → accept/preparing/ready via REST; backend `GET /merchant/orders` added. **Critical-journey E2E is a vitest+RTL (jsdom) integration test (CI-run, deterministic); Playwright-in-browser deferred** (no browser in CI/sandbox — RTL proves the journey). **Phase 6 feature-complete → STOP for review before Phase 7.**
- [x] **Phase 7 — Settlements, payouts & admin/reporting** *(feature-complete; PRs #33–#34 + open `phase-7-reports`)*: plan locked 2026-10-21 — on-demand (period param, no scheduler), dual-sign payouts (finance+ops), simulated M-Pesa B2C (no cash guard), ledger = source of truth. ✅ Inc1 merchant settlements (`0020_settlements`: `settlement`+`settlement_line`; `generateSettlements` per merchant/period `net = gross − commission − refunds` over delivered non-fully-refunded orders (D14 partials merchant-borne); idempotent via `UNIQUE(merchant,period)`; finance `approveSettlement`; `POST /admin/settlements/generate|:ulid/approve` + `GET`; `settlement:approve` policy) (PR #33). ✅ Inc2 payouts (`0021_payouts`: `payout`+`payout_line`; `generatePayouts` = one merchant payout per approved settlement + one rider payout per rider's delivered fees, idempotent per payee+period; **dual-sign** finance+ops (two distinct users) before execute; simulated M-Pesa B2C `PayoutGateway` execute→`processing`→confirm; success posts `DR merchant_payable|rider_payable / CR mpesa_clearing` idempotent `payout:{id}` + marks source settlement `paid`, fail→`failed`, replay no-op; `payout:approve` policy; **D16** recorded) (PR #34). ✅ Inc3 reports — read-only, **no migration** (`reports/{repo,report-service}`; `GET /admin/reports/summary` = GMV (Σ delivered total), volumes by status, cancel rate (cancelled+rejected), refund rate (payment_status refunded/partial), rider utilization (distinct riders/deliveries/Σfees); `GET /admin/reports/ledger` = per-account natural balances + `findImbalancedTransactions` invariant flag; both `audit:read`) (open PR `phase-7-reports`). **Phase 7 feature-complete → STOP for review before Phase 8.**
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
| #12 | 2.4 | Inventory + reserve/release (concurrency) |
| #13 | 2.5 | Public catalogue browse (approved/open only) |
| #14 | 3.1 | Delivery zones (circle) + customer addresses |
| #15 | 3.2 | Delivery-fee rules (time-boxed) + haversine fee calc |
| #16 | 3.3 | Shopping cart (single-merchant + option validation) |
| #17 | 3.4 | Cart quote (authoritative pricing) + promotions |

## Key locked decisions (see decision-log.md / ADRs)
- **Launch (D1):** Migori; zones are configurable DB records; **spatial zone resolution deferred to Phase 3**.
- **Data access:** Knex (ADR-0001). **Money:** integer cents, double-entry ledger; server is the source of truth for all prices/fees/commission.
- **Auth:** RS256 via `jsonwebtoken`; argon2id; MySQL-backed OTP throttling; phone-OTP + dashboard password (**TOTP deferred**).
- **Commission (D2):** server-controlled `commission_bps` per merchant, admin-set.
- **Phase 2:** admin-created merchant onboarding; **town-level** browse filtering; product **optimistic locks** (edits require expected `version`). `category`/`merchant`/`product` carry a public `ulid`.
