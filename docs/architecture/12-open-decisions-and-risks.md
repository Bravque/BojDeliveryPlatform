# 12 — Open Business Decisions, Challenged Assumptions & Risks

> Status: **Reviewed 2026-10-17.** RESOLVED in the review (see `decisions/decision-log.md` for
> authoritative values): **D1, D3, D6, D7, D8, D10, D11, D12**, plus the ORM choice (Knex,
> ADR-0001). Still open: **D2** (commission — 5–12% is a hypothesis to validate with
> merchants), **D4, D5, D9, D13, D14, D15**. The table below is retained for historical
> context; where a row is resolved, the decision log governs.

## 1. Open business decisions (need your answer)

| # | Decision | Why it matters | Proposed default | Blocks |
|---|----------|----------------|------------------|--------|
| D1 | **Launch town** and its initial delivery zones | Zones drive fees, assignment radius, maps config | — (needs you) | Phase 3 |
| D2 | **Commission model** (flat % vs. per-category vs. per-merchant) and the rate(s) | Drives settlement math and merchant contracts | Flat % per merchant via `commission_bps`, set per merchant | Phase 4/7 |
| D3 | **Delivery-fee formula** values (base, per-km, min, max, surge) | Customer-facing price + rider economics | base + per-km, clamped; surge=1.0 | Phase 3 |
| D4 | **Who funds promotions & delivery discounts** (platform vs. merchant) | Determines ledger split on capture | Platform-funded promos | Phase 4 |
| D5 | **Rider economics**: is rider fee = delivery fee, or a separate rate; who keeps margin | Rider payouts + unit economics | Separate rider-rate; platform keeps margin | Phase 5/7 |
| D6 | **Payment timing**: payment-first (refund on reject) vs. accept-first (pay after) | Refund volume vs. unpaid-work risk | Payment-first + fast auto-refund | Phase 4 |
| D7 | **Proof of delivery** method (PIN / photo / signature / none) | Dispute handling, fraud | **Resolved (D7):** customer delivery **PIN** (default), entered by rider; photo optional | Phase 5 |
| D8 | **Auth method** for customers (phone-OTP only vs. +password) | UX, security, SMS cost | Phone-OTP for customer/rider; password for dashboards | Phase 1 |
| D9 | **Cancellation & refund policy** (windows, fees, no-refund cases) | Legal + ledger + UX | Free cancel pre-accept; post-accept case-by-case via ops | Phase 4 |
| D10 | **Merchant accept SLA** and **payment retry window** values | Timeout behavior | **Resolved (D10):** 3 min accept SLA; 2 min pay window (configurable) | Phase 3/4 |
| D11 | **Maps provider**: Google Maps vs. Mapbox | Cost, quota, coverage in KE | **Resolved (D11):** Google Maps (initial), behind a provider interface; haversine fallback regardless | Phase 3/5 |
| D12 | **SMS/OTP provider** (Africa's Talking, TalkSasa, etc.) | Deliverability in KE, cost | **Resolved (D12):** evaluate Africa's Talking + TalkSasa, behind a notification interface | Phase 1 |
| D13 | **Settlement cadence** (daily/weekly) and payout rails (M-Pesa B2C vs. bank) | Cash flow, fees | Weekly settlement; M-Pesa B2C payouts | Phase 7 |
| D14 | **Cloud/hosting provider** and region | DR, latency, cost | Managed MySQL+Redis provider near KE/EU; single region at launch | Phase 0/8 |
| D15 | **Financial-record retention period** (KRA/DPA) | Backup retention, deletion policy | Confirm with Finance/Legal (often ~7 yrs tax) | Phase 8 |

## 2. Challenged assumptions (I pushed back on these)

- **"Independent riders" = assignment risk.** Independent riders go offline unpredictably, so
  assignment can stall. Mitigation: candidate freshness windows, offer timeouts, ops
  escalation, and SLA metrics from day one. Consider a small incentivized on-call pool at
  launch. *(Confirm launch rider supply plan.)*
- **One merchant per order is a feature, not just a limit.** Enforced by an application guard,
  but the schema (`order_merchant`-ready) keeps multi-merchant additive. Don't hard-code the
  single-merchant assumption into pricing/settlement logic.
- **STK callbacks are not trustworthy on their own.** Daraja callbacks are unsigned and can be
  delayed/duplicated/spoofed. We treat them as hints and confirm via status query +
  reconciliation; capture is idempotent. Do **not** mark paid on callback alone for
  high-value orders without confirmation.
- **Floating-point money is a latent disaster.** Hence integer cents + double-entry ledger
  everywhere. This is non-negotiable and baked into `packages/money`.
- **"Realtime everywhere" is over-engineering.** Socket.IO is scoped to tracking/offers/alerts
  only; canonical state always comes from REST. Avoids state drift and socket-auth sprawl.
- **Microservices now would hurt.** A modular monolith keeps money + orders in one
  transactional DB; premature service splits create distributed-transaction pain. Extract
  later only under real scaling/ownership pressure.
- **Prisma vs. Knex — RESOLVED (ADR-0001): Knex.** We need robust `SELECT … FOR UPDATE`,
  explicit transactions, and raw SQL for ledger/stock/spatial; Knex gives that raw control
  with hand-authored, reviewable migrations. See
  `decisions/0001-data-access-knex-over-prisma.md`.
- **Expo managed workflow limits.** Background location and some native modules may require
  config plugins / dev builds. Validate rider background-location feasibility early (Phase 5
  risk).

## 3. Top risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Money loss / double-credit from payment edge cases | Severe (trust, legal) | Idempotency keys, unique receipts, append-only events, double-entry ledger, daily reconciliation, imbalance alerts |
| Oversold stock under concurrency | Customer/merchant disputes | Reserve-on-checkout with optimistic/pessimistic locking + concurrency tests |
| Rider assignment stalls / double-assignment | Failed deliveries | Atomic accept with row lock + unique constraint; timeouts; ops escalation |
| Daraja outages / credential delays | Launch blocker | Simulated gateway builds the whole flow first; sandbox before prod; adapter swap |
| Data-protection non-compliance (DPA 2019) | Legal/fines | Consent, minimization, retention policy, audited PII access, subject-rights workflows |
| Backup that was never test-restored | Catastrophic on incident | Mandatory restore drill as an acceptance criterion (doc 10) |
| Schema migration breaks rolling deploy | Downtime/data loss | Expand/contract, backward-compatible migrations, gated pre-deploy step, rollback plan |
| Maps/SMS cost overruns | Budget | Caching, haversine fallback, rate limiting, provider choice (D11/D12) |
| Connectivity-poor mobile use | Lost orders/UX | Offline-safe cart, idempotent actions, retry on reconnect, server as source of truth |

## 4. Status & remaining open items

**Approved 2026-10-17** to proceed to Phase 0. Phase-blocking decisions (D1, D3, D6, D7, D8,
D10, D11, D12) and the ORM choice are **resolved** — see `decisions/decision-log.md`.

Still needing resolution (not blocking Phase 0; required before the noted phase):

- **D2 / commission** — 5–12% is a hypothesis; validate with real Migori merchants (Phase 4/7).
- **D4** — who funds promotions/delivery discounts (Phase 4).
- **D5** — rider margin ownership (Phase 5/7).
- **D9** — cancellation & refund policy details (Phase 4).
- **D13** — settlement cadence & payout rails (Phase 7).
- **D14** — cloud/hosting provider & region (Phase 0 infra / Phase 8).
- **D15** — financial-record retention period per KRA/DPA (Phase 8).

Not blocking Phase 0, but still needed from you when convenient: budget, team size/skills,
timeline, legal entity, and any existing Safaricom/merchant relationships.
