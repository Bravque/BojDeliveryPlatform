# 11 — Delivery Phases & Acceptance Criteria

> Status: DRAFT for review. Each phase is a small, reviewable increment (CLAUDE.md). A phase
> is "done" only when its acceptance criteria are met **and verified by reported tests**. We
> build the money/order correctness core early, behind a simulated payment gateway, so the
> riskiest logic is proven before UI polish.

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
- [ ] `pnpm install && turbo run build lint test` passes from a clean checkout.
- [ ] API boots and fails fast on invalid env; `/health` returns dependency status.
- [ ] A trivial migration applies up/down; seed loads a synthetic town.
- [ ] CI green on an empty-but-wired PR.

## Phase 1 — Identity, roles & authorization core
**Goal:** authn + RBAC skeleton usable by later phases.
- Phone-OTP login, dashboard email/password, JWT access + rotating refresh, logout.
- Role model + policy layer + ownership checks; audit log write path.

**Acceptance:**
- [ ] OTP flow works against mock SMS with throttling/lockout; no user enumeration.
- [ ] Protected routes reject missing/invalid/expired tokens.
- [ ] Policy unit tests cover role + ownership for representative actions.
- [ ] Refresh rotation + reuse-detection tested.

## Phase 2 — Catalogue, inventory & merchants
**Goal:** merchants and their products exist and are browsable.
- Merchant onboarding/approval (admin), catalogue CRUD, options, availability, inventory.
- Public catalogue reads with zone-aware merchant filtering.

**Acceptance:**
- [ ] Merchant can manage catalogue; customer can browse only approved/open merchants.
- [ ] Price edits bump `version`; client cannot set prices.
- [ ] Inventory reserve/release primitives exist with a passing concurrency unit test.

## Phase 3 — Cart, pricing & order creation (no payment yet)
**Goal:** correct, server-authoritative pricing and order snapshot.
- Cart (single-merchant), `POST /cart/quote`, zone resolution + delivery fee, promotions,
  `POST /orders` with stock reservation and full price snapshot into `order`/`order_item`.
- Order state machine wired through `draft`/`cancelled` with history.

**Acceptance:**
- [ ] Totals computed server-side; identical inputs → identical totals; out-of-zone blocks.
- [ ] Concurrency test: N checkouts on 1-stock product → exactly one succeeds.
- [ ] Promotion caps/eligibility/limits enforced; never a negative total.
- [ ] Illegal state transitions rejected; history written atomically.

## Phase 4 — Payments (simulated) & ledger
**Goal:** prove the entire money machine before real Daraja.
- `PaymentGateway` interface + `SimulatedGateway`; STK initiate/callback/status;
  double-entry ledger capture; idempotency + dedupe; timeouts; reconciliation job;
  refunds (full/partial).

**Acceptance:**
- [ ] Duplicate callback ×100 → one capture, one ledger txn, one receipt.
- [ ] Amount-mismatch callback quarantined, never captured.
- [ ] Timeout → status-query resolution; late-success-after-cancel → auto-refund.
- [ ] Ledger balances across order→refund lifecycle; imbalance job clean.
- [ ] Refund idempotency: no double refund.

## Phase 5 — Rider onboarding, assignment & delivery
**Goal:** get an order from `ready_for_pickup` to `delivered`.
- Rider onboarding/approval, online/offline, location; candidate selection; time-boxed
  offers; atomic accept with conflict resolution; pickup/deliver with proof; rider earnings
  accrual.

**Acceptance:**
- [ ] K simultaneous accepts → exactly one winner, others `409`.
- [ ] Offer expiry re-offers; exhaustion escalates to ops.
- [ ] Delivery fee (customer) and rider fee (earnings) stored separately and snapshotted.
- [ ] Full happy-path order lifecycle passes end-to-end (API, simulated payment).

## Phase 6 — Realtime, notifications & client apps (MVP)
**Goal:** usable apps on top of the proven backend.
- Socket.IO (order tracking, offers, merchant alerts) with room authorization.
- Push (Expo/FCM) + SMS notifications.
- Customer app, rider app, merchant dashboard MVP flows; admin dashboard core.

**Acceptance:**
- [ ] Socket rooms authorized; unauthorized joins rejected.
- [ ] Each persona completes its critical journey in E2E tests.
- [ ] Realtime payloads are notifications only; clients re-fetch canonical state.

## Phase 7 — Settlements, payouts & admin/reporting
**Goal:** operators can run the business and get everyone paid.
- Settlement generation + approval; payout batches (simulated B2C) with idempotency;
  reconciliation UI; reports (GMV, volumes, cancel/refund rates, rider utilization);
  disputes/overrides with audit.

**Acceptance:**
- [ ] Settlement math (gross − commission − refunds) matches ledger; idempotent payouts.
- [ ] Reconciliation surfaces injected mismatches without auto-moving money.
- [ ] Every override/refund/payout is audited with actor + reason + before/after.

## Phase 8 — Production hardening & Daraja go-live
**Goal:** flip from simulated to production safely.
- Real Daraja (sandbox → production) via adapter swap; load/soak tests; backup **restore
  drill performed**; runbooks; security review; DPA compliance sign-off.

**Acceptance:**
- [ ] Switching `PAYMENT_PROVIDER` to Daraja requires no changes outside the adapter.
- [ ] Load test meets latency/throughput targets at 10× launch volume projection.
- [ ] A real restore drill has been executed and its result recorded.
- [ ] Security review and data-protection checklist signed off.

---

**Cross-cutting rule for every phase:** changed files + verification results are summarized in
the PR, regressions fixed, and remaining risks/unfinished work identified (CLAUDE.md delivery
workflow).
