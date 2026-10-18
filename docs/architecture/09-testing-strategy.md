# 09 — Testing Strategy

> Status: DRAFT for review. Per CLAUDE.md, no feature is claimed "working" until tested, and
> test results are reported. Tests use **synthetic data only** — never production PII.

## 1. Test pyramid

| Layer | Scope | Tooling (proposed) | Where |
|-------|-------|--------------------|-------|
| **Unit** | Pure logic: pricing, money math, state-machine transitions, policies, promo rules | Vitest/Jest | all packages/apps |
| **Integration** | Service + real MySQL + Redis (Testcontainers), transactions, locking | Vitest + Testcontainers | `apps/api` |
| **Contract** | REST ↔ OpenAPI; client types; error envelopes | supertest + openapi validators | `apps/api`, `packages/api-client` |
| **E2E (API)** | Full order→pay→assign→deliver→settle via simulated gateway | supertest/Playwright API | `apps/api` |
| **E2E (UI)** | Critical customer/merchant/rider/admin journeys | Playwright (web), Detox/Maestro (mobile) | apps |
| **Non-functional** | Load, concurrency, soak | k6/Artillery | CI nightly |

Most value concentrates in **unit + integration** for the money/order/assignment core.

## 2. Critical paths that MUST have tests (the risky areas from the brief)

1. **Concurrent orders & stock** — N parallel checkouts on limited stock → exactly the
   available quantity succeeds; no oversell; reservations released on failure/cancel.
2. **Duplicate payment callbacks** — same callback replayed many times → exactly one capture,
   one ledger transaction, one receipt credited.
3. **Payment timeouts & reconciliation** — STK timeout then late success; status-query
   resolution; late-success-after-cancel → auto-refund.
4. **Order cancellations & refunds** — refund amount bounds, idempotent approve/execute, no
   double refund, correct ledger reversal.
5. **Rider assignment conflicts** — K simultaneous accepts → one winner, others `409`; offer
   expiry re-offer; exhaustion escalation.
6. **Merchant/rider payouts** — settlement math (gross − commission − refunds), idempotent
   payout execution, no double pay.
7. **Ledger integrity** — every transaction balances; invariant job flags imbalance.
8. **AuthZ** — role + ownership enforced server-side; forbidden requests rejected even when
   the UI would hide the control.
9. **State machine** — every illegal transition rejected; history written atomically.
10. **Migrations** — up/down apply cleanly; restore-from-backup drill (doc 10).

These are implemented as deterministic tests against the **SimulatedGateway** and a real
MySQL/Redis via Testcontainers.

## 3. Techniques

- **Concurrency testing**: fire parallel requests within a single test, assert DB invariants
  (counts, sums) rather than timing.
- **Property-based testing** for the state machine and money math (e.g. fast-check): random
  valid event sequences never violate invariants (doc 04 §5).
- **Golden ledger tests**: full lifecycle produces an expected set of balanced entries.
- **Idempotency harness**: a helper that replays each unsafe request/callback and asserts a
  single effect.
- **Fixtures/factories** generate synthetic merchants, products, riders, addresses, zones.

## 4. Coverage & quality gates (CI)

- Type check (`tsc --noEmit`), lint (ESLint), format (Prettier) must pass.
- Unit + integration must pass; coverage thresholds on **money/order/assignment/payment**
  modules set high (e.g. ≥ 90% lines + branch), lower elsewhere.
- OpenAPI ↔ Zod drift check fails the build.
- No test may hit real Daraja, real SMS, or real maps billing; external calls are mocked or
  routed to sandboxes.
- Security checks: dependency audit, secret scanning, basic SAST.

## 5. Test data & environments

- `packages/config` provides a test profile; a `docker-compose.test.yml` brings up MySQL,
  Redis, MinIO, mock-daraja.
- Seeds are explicitly synthetic and labeled; a guard prevents seeds/tests from running
  against a production-tagged database URL.

## 6. Manual / exploratory

- Staging smoke checklist before each release (place order, pay via sandbox, assign, deliver,
  refund, settle). Results recorded in the PR per CLAUDE.md.

## 7. Acceptance criteria

- [ ] CI runs unit + integration + contract on every PR and blocks on failure.
- [ ] All ten critical-path test suites (§2) exist and pass before the corresponding feature
      is called "done".
- [ ] Coverage gates enforced on financial/order modules.
- [ ] A documented command spins up the full local test stack reproducibly.
