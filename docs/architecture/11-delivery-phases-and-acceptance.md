# 11 — Delivery Phases & Acceptance Criteria

> Status: DRAFT for review. Each phase is a small, reviewable increment (CLAUDE.md). A phase
> is "done" only when its acceptance criteria are met **and verified by reported tests**. We
> build the money/order correctness core early, behind a simulated payment gateway, so the
> riskiest logic is proven before UI polish.

> **Acceptance reconciliation (2026-10-25):** boxes are now ticked to match merged + tested
> work (PRs #1–#40). Legend: `[x]` = delivered and verified by CI/tests; `[~]` = partially met
> (scope note inline); `[ ]` with an _(operator-run)_ note = enabling code/artifacts delivered
> and tested in-repo, but the **real-infra execution** cannot run on the dev box (no Safaricom
> creds, no deployed env, no managed MySQL/Redis) and remains for the operator before launch
> (tracked in `docs/ops/go-live-checklist.md`).

## Phase 0 — Foundations & scaffolding
**Goal:** a bootable monorepo with CI, config, DB, and no business features.
- Monorepo (pnpm + Turborepo), shared TS/lint/format, `packages/config`, `packages/money`.
- `apps/api` boots with zod-validated env; health endpoint; structured logging + request id.
- MySQL + Redis + MinIO via docker-compose; migration tooling; seed harness.
- CI: typecheck, lint, test, build.

> **Delivered vs. deferred (2026-10-17):** the `mock-daraja` container is **deferred to
> Phase 4 (Payments)** — there is no payment code to mock yet, and adding an empty service now
> would be scaffolding noise. It is listed here only as a forward reference; the local
> infrastructure for Phase 0 is MySQL + Redis + MinIO.

**Acceptance:**
- [x] `pnpm install && turbo run build lint test` passes from a clean checkout.
- [x] API boots and fails fast on invalid env; `/health` returns dependency status.
- [x] A trivial migration applies up/down; seed loads a synthetic town.
- [x] CI green on an empty-but-wired PR.

## Phase 1 — Identity, roles & authorization core
**Goal:** authn + RBAC skeleton usable by later phases.
- Phone-OTP login, dashboard email/password, JWT access + rotating refresh, logout.
- Role model + policy layer + ownership checks; audit log write path.

**Acceptance:**
- [x] OTP flow works against mock SMS with throttling/lockout; no user enumeration.
- [x] Protected routes reject missing/invalid/expired tokens.
- [x] Policy unit tests cover role + ownership for representative actions.
- [x] Refresh rotation + reuse-detection tested.

## Phase 2 — Catalogue, inventory & merchants
**Goal:** merchants and their products exist and are browsable.
- Merchant onboarding/approval (admin), catalogue CRUD, options, availability, inventory.
- Public catalogue reads with zone-aware merchant filtering.

**Acceptance:**
- [x] Merchant can manage catalogue; customer can browse only approved/open merchants.
- [x] Price edits bump `version`; client cannot set prices.
- [x] Inventory reserve/release primitives exist with a passing concurrency unit test.

## Phase 3 — Cart, pricing & order creation (no payment yet)
**Goal:** correct, server-authoritative pricing and order snapshot.
- Cart (single-merchant), `POST /cart/quote`, zone resolution + delivery fee, promotions,
  `POST /orders` with stock reservation and full price snapshot into `order`/`order_item`.
- Order state machine wired through `draft`/`cancelled` with history.

**Acceptance:**
- [x] Totals computed server-side; identical inputs → identical totals; out-of-zone blocks.
- [x] Concurrency test: N checkouts on 1-stock product → exactly one succeeds.
- [x] Promotion caps/eligibility/limits enforced; never a negative total.
- [x] Illegal state transitions rejected; history written atomically.

## Phase 4 — Payments (simulated) & ledger
**Goal:** prove the entire money machine before real Daraja.
- `PaymentGateway` interface + `SimulatedGateway`; STK initiate/callback/status;
  double-entry ledger capture; idempotency + dedupe; timeouts; reconciliation job;
  refunds (full/partial).

**Acceptance:**
- [x] Duplicate callback ×100 → one capture, one ledger txn, one receipt.
- [x] Amount-mismatch callback quarantined, never captured.
- [x] Timeout → status-query resolution; late-success-after-cancel → auto-refund.
- [x] Ledger balances across order→refund lifecycle; imbalance job clean.
- [x] Refund idempotency: no double refund.

## Phase 5 — Rider onboarding, assignment & delivery
**Goal:** get an order from `ready_for_pickup` to `delivered`.
- Rider onboarding/approval, online/offline, location; candidate selection; time-boxed
  offers; atomic accept with conflict resolution; pickup/deliver with proof; rider earnings
  accrual.

**Acceptance:**
- [x] K simultaneous accepts → exactly one winner, others `409`.
- [x] Offer expiry re-offers; exhaustion escalates to ops.
- [x] Delivery fee (customer) and rider fee (earnings) stored separately and snapshotted.
- [x] Full happy-path order lifecycle passes end-to-end (API, simulated payment).

## Phase 6 — Realtime, notifications & client apps (MVP)
**Goal:** usable apps on top of the proven backend.
- Socket.IO (order tracking, offers, merchant alerts) with room authorization.
- Push (Expo/FCM) + SMS notifications.
- Customer app, rider app, merchant dashboard MVP flows; admin dashboard core.

**Acceptance:**
- [x] Socket rooms authorized; unauthorized joins rejected.
- [~] Each persona completes its critical journey in E2E tests. _(Partial — Phase 6 MVP scope
  shipped **one** thin client, `merchant-web`, with a vitest+RTL critical-journey test;
  customer/rider native apps and Playwright-in-browser E2E are post-MVP, deferred.)_
- [x] Realtime payloads are notifications only; clients re-fetch canonical state.

## Phase 7 — Settlements, payouts & admin/reporting
**Goal:** operators can run the business and get everyone paid.
- Settlement generation + approval; payout batches (simulated B2C) with idempotency;
  reconciliation UI; reports (GMV, volumes, cancel/refund rates, rider utilization);
  disputes/overrides with audit.

**Acceptance:**
- [x] Settlement math (gross − commission − refunds) matches ledger; idempotent payouts.
- [x] Reconciliation surfaces injected mismatches without auto-moving money.
- [x] Every override/refund/payout is audited with actor + reason + before/after.

## Phase 8 — Production hardening & Daraja go-live
**Goal:** flip from simulated to production safely.
- Real Daraja (sandbox → production) via adapter swap; load/soak tests; backup **restore
  drill performed**; runbooks; security review; DPA compliance sign-off.

**Acceptance:**
- [x] Switching `PAYMENT_PROVIDER` to Daraja requires no changes outside the adapter.
  _(Code-verified: `buildGateway()` selects `DarajaGateway`/`DarajaPayoutGateway` by
  `PAYMENT_PROVIDER` with no other change; adapters tested vs a local fake-Daraja server. A live
  sandbox/prod run is operator-run — see `docs/ops/runbooks/daraja-cutover.md`.)_
- [ ] Load test meets latency/throughput targets at 10× launch volume projection.
  _(Operator-run — k6 harness delivered at `scripts/load-test/order-flow.js`; run vs staging and
  record the summary.)_
- [ ] A real restore drill has been executed and its result recorded.
  _(Operator-run — `scripts/backup-mysql.sh` + `scripts/restore-drill.sh` delivered; needs real
  MySQL. Record result in `docs/ops/runbooks/restore.md` §Record.)_
- [ ] Security review and data-protection checklist signed off.
  _(Operator-run — `docs/ops/security-review-checklist.md` + `docs/ops/data-protection-dpa-checklist.md`
  delivered; need human + DPO/Legal signatures.)_

> **Merchant B2C payout destination (closed):** merchants now carry a `payout_phone_e164`
> (migration `0023`), set by admin/ops via `POST /api/v1/admin/merchants/:ulid/payout-destination`;
> `getPayeeMsisdn('merchant', …)` resolves it (parity with riders' `user.phone_e164`). A merchant
> with no destination still (correctly) fails a Daraja payout — now fixable by data entry rather
> than unmodellable. **Operator action:** set each approved merchant's destination before its first
> Daraja payout (`docs/ops/go-live-checklist.md`).

---

**Cross-cutting rule for every phase:** changed files + verification results are summarized in
the PR, regressions fixed, and remaining risks/unfinished work identified (CLAUDE.md delivery
workflow).
