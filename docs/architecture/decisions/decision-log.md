# Decision Log

Accepted decisions, most recent first. Values here are **authoritative**; the design
documents (`../01`…`../12`) are updated to match and point back here.

---

## 2026-10-21 — Phase 8: background jobs + horizontal-scale readiness (D18)

| ID | Decision | Accepted value | Notes / guardrails |
|----|----------|----------------|--------------------|
| **D18** | How scheduled background jobs run, and how realtime scales across instances | An **in-process interval scheduler** (`platform/scheduler`) gated by `SCHEDULER_ENABLED`, running on **exactly one instance**, drives the two previously on-demand jobs: the stale-payment **reconcile sweep** (`reconcileStalePayments`) and the assignment-offer **expiry tick** (`assignmentService.tick`). Realtime uses the **Socket.IO Redis adapter only when `REDIS_URL` is set** (`attachScaleAdapter`), otherwise a single in-memory instance. No new infrastructure is required to run or test. | A durable, multi-instance queue (BullMQ) stays **deferred to an actual multi-instance deployment** — consistent with Phases 4–7 keeping generation/reconcile/ticks operator- or tick-driven. Every scheduled operation is **idempotent** (reconcile/confirm/tick are no-ops when already settled), so a missed, duplicated, or double-instance run cannot double-pay or double-capture; the single-instance rule only avoids wasted work. A failing job run is **logged and swallowed** so one bad tick never kills the loop. Timer functions are injectable, so cadence is unit-tested without real time. The Redis-attached branch is exercised at deploy time (real Redis), not in CI; the no-Redis branch is unit-tested. |

---

## 2026-10-21 — Phase 8: Daraja go-live approach + callback hardening (D17)

| ID | Decision | Accepted value | Notes / guardrails |
|----|----------|----------------|--------------------|
| **D17** | How the real Daraja (M-Pesa) integration is built and cut over, and how its callbacks are trusted | The Daraja adapters (`DarajaGateway` STK now, `DarajaPayoutGateway` B2C + reversal next) live **entirely behind** the existing `PaymentGateway`/`PayoutGateway` interfaces and are selected by `PAYMENT_PROVIDER=daraja_sandbox\|daraja_prod`; **switching providers changes nothing outside the adapter folder**. They are built and tested against a **local fake-Daraja HTTP server** (no new HTTP-client dependency — Node 20 global `fetch`); the **live cutover is a deploy-time credentials + `PAYMENT_PROVIDER` flip** the operator performs (this sandbox has no Safaricom creds). Callbacks are treated as **hints, not trusted**: the STK webhook is hardened with an optional **source-IP allow-list** + the shared `X-Webhook-Token`, raw events are persisted + de-duplicated, and capture is confirmed by **amount match** (+ an independent `queryStkStatus` for high value). | Honors doc 07 §2 ("switching `PAYMENT_PROVIDER` requires no changes outside the adapter") and the Phase-8 acceptance. **Amounts:** M-Pesa `Amount` is whole **KES shillings**; the ledger is integer **cents** — the adapter converts cents→shillings and **rejects non-whole-shilling amounts** (should never occur for KES pricing). **STK Query limitation:** the STK Push Query API returns status only (no amount/receipt), so a query-confirmed success with no callback stays **unverified** (`amountCents=null` → the capture service quarantines rather than capturing an unverified sum). OAuth tokens are cached until just before expiry. Daraja does not sign callbacks, hence the IP allow-list + token + amount-verify defense-in-depth. Real-sandbox end-to-end, load, and go-live steps are **operator-run** (not reproducible in this sandbox). |

---

## 2026-10-21 — Phase 7: settlement/payout cadence + payout rail (D16)

| ID | Decision | Accepted value | Notes / guardrails |
|----|----------|----------------|--------------------|
| **D16** | How settlements/payouts are run and how money leaves the platform | **On-demand, operator-triggered** generation with the period as an explicit parameter (`{ periodStart, periodEnd }`) — no scheduler this phase. Payouts use a **simulated M-Pesa B2C** rail (`PayoutGateway`/`SimulatedPayoutGateway`): execute → provider ref → out-of-band confirm (dev-simulate / webhook), mirroring the STK + refund-reversal seams. A payout is **dual-signed**: a finance approval **and** an ops approval by **two distinct users** are required before execute. | (The payout/settlement cadence + B2C-rail question the Phase-7 plan tracked as a placeholder "D13"; **D13 was already assigned** to the zone model, so it lands here as **D16**.) Cadence = how often ops run the endpoints; a real scheduler (BullMQ) stays deferred to Phase 8, consistent with Phases 4–6. Idempotency is enforced end-to-end: `UNIQUE(merchant_id, period_start, period_end)` on settlement, `payout.idempotency_key` UNIQUE, and the ledger draw-down keyed `payout:{id}` — so re-generate / double-confirm never double-pays. A payout is **never `paid` until the B2C result is confirmed** (D6 parity): execute → `processing`; only the confirmed success posts `DR merchant_payable|rider_payable / CR mpesa_clearing` and marks the source settlement `paid`; failure is retryable without double-paying. Real Daraja B2C swaps in behind `PayoutGateway` in Phase 8 with no service change. No E9 float/cash guard this phase. |

---

## 2026-10-20 — Phase 5: rider fee model (D15)

| ID | Decision | Accepted value | Notes / guardrails |
|----|----------|----------------|--------------------|
| **D15** | How a rider's earning is set (resolves open **D5**) | A **configurable rate**; the platform keeps the margin between the customer `delivery_fee` and the rider fee. Rider fee is capped at the delivery fee (margin ≥ 0). | Isolated in one pure function `delivery/rider-fee.ts` (`computeRiderFeeCents(deliveryFeeCents, flatRateCents)`), config `RIDER_FEE_FLAT_CENTS`. Snapshotted into `delivery.rider_fee_cents` at accept (never rewritten by later rate changes). Earnings accrue on delivery (`DR platform_delivery_income / CR rider_payable:{riderId}` for the rider fee) in Phase 5 Inc 5, leaving the platform margin in `platform_delivery_income`. Swapping to a per-zone rate or distance formula is a change in that one file only. |

---

## 2026-10-19 — Phase 4: refund cost-bearer + reversal ledger split (D14)

| ID | Decision | Accepted value | Notes / guardrails |
|----|----------|----------------|--------------------|
| **D14** | Who bears a refund in the ledger | A **full** refund (whole order total, no prior partials) reverses the capture exactly. A **partial** refund is **merchant-borne**: clawed back from `merchant_payable:{m}` into `refunds_payable`. | Matches doc 07 §10 (settlement net = gross − commission − refunds). The refund liability lands in `refunds_payable`; the cash outflow is settled at payout (Phase 7). Merchant-funded partials keep the primitive simple and avoid proportional cent-rounding; a future per-refund split policy can be added without changing call sites. |

**Refund reversal ledger split** (posted on completion; `kind = order_refund`, idempotent via `order_refund:{refundId}`):
```
# FULL refund (mirror of the capture, swapping mpesa_clearing → refunds_payable)
DR merchant_payable:{m}        subtotal − commission
DR commission_revenue          commission
DR platform_delivery_income    delivery_fee
DR platform_service_income     service_fee
  CR refunds_payable             total
  CR promo_expense               discount                 // platform recovers the promo (D4)

# PARTIAL refund (amount a < total) — merchant-borne (D14)
DR merchant_payable:{m}        a
  CR refunds_payable             a

# AUTO refund of an uncaptured-but-collected payment (late success after cancel)
DR mpesa_clearing              a
  CR refunds_payable             a
```
Lifecycle `requested → approved → processing → completed` (+ `rejected`/`failed`); separation of
duties (requester ≠ approver) on manual refunds; `refund.idempotency_key` UNIQUE + the ledger
idempotency key make a duplicate approve/execute a no-op. Shipped: `refund` table (`0015_refunds`)
+ `RefundService` + auto-refund hook in Phase 4 Inc 5.

---

## 2026-10-19 — Phase 4: promotion funding (D4) + capture ledger split

| ID | Decision | Accepted value | Notes / guardrails |
|----|----------|----------------|--------------------|
| **D4** | Who funds promotion discounts | **Platform-funded.** The merchant is paid on the full subtotal (minus commission); the platform absorbs the discount to a `promo_expense` account. | Resolves the doc-12 open item (leaning confirmed). Keeps merchant economics independent of platform marketing promos. Merchant-funded promos can be added later as a per-promotion attribute without changing the ledger primitive. |

**Capture ledger split** (customer pays `total = subtotal + delivery_fee + service_fee − discount`), posted atomically with the payment/order state change (doc 07 §7):
```
DR mpesa_clearing              total
DR promo_expense               discount                 // platform-funded (D4)
  CR merchant_payable:{m}        subtotal − commission
  CR commission_revenue          commission
  CR platform_delivery_income    delivery_fee           // reclassed to rider_payable on delivery (Phase 5)
  CR platform_service_income     service_fee
```
Debits (`total + discount`) == credits (`subtotal + delivery + service`). Shipped: ledger tables +
`LedgerService` in Phase 4 Inc 1 (migration `0013_ledger`); the capture posting lands in Inc 3.

---

## 2026-10-19 — Phase 3: delivery zones modelled as circles (not GEOMETRY polygons)

| ID | Decision | Accepted value | Notes / guardrails |
|----|----------|----------------|--------------------|
| **D13** | Zone serviceable-area model (refines **D1**) | A zone is a **circle**: `center_lat` + `center_lng` + `radius_m`. An address is serviceable when it lies within an **active** zone's radius (haversine distance). When zones overlap a point, the **nearest centre** wins (a deterministic, total resolution function). | Chosen for the single compact Migori CBD launch (D1): simpler than a polygon, **unit-testable without MySQL spatial** (no local DB on the dev box), and boundaries stay **config-driven** (centre/radius are admin-set DB records, nothing hardcoded). The circle columns are nullable while a zone is being configured and are **required by the service before a zone can be activated or used to resolve** an address. Distance uses **haversine** (straight-line) for now — consistent with D11 (Google Maps route distance arrives later behind the provider interface). **Future enhancement:** a GEOMETRY polygon + point-in-polygon model when precise or multi-zone boundaries are needed; `zone` can migrate to add a boundary column without changing the resolution call sites. |

### Consequences for existing documents

- `03-data-model.md` §3.2/§3.3: `zone` replaces the illustrative `boundary GEOMETRY ... SPATIAL
  INDEX` with `center_lat`/`center_lng`/`radius_m`; `town`, `zone` and `address` gain a public
  `ulid`. Shipped in migration `0008_zones_and_addresses` (Phase 3 Inc 1).

---

## 2026-10-17 — Architecture review: approved to proceed to Phase 0 (with conditions)

The architecture plan (`docs/architecture/00`–`12`) was **approved in principle**. Phase 0
(Foundations & Scaffolding) is authorized as a small, reviewable, tested, reversible
increment. Phase 1 must not start until the Phase 0 diff + verification report are reviewed.

### Business & operational decisions

| ID | Decision | Accepted value | Notes / guardrails |
|----|----------|----------------|--------------------|
| **D1** | Launch town & zones | **Migori, Kenya** — compact Migori Town/CBD service area. Zones are **configurable DB records**. | Awendo, Rongo, Kehancha, Isebania and others stay **inactive** until the model is validated. No hardcoded boundaries; not every address is serviceable. |
| **D3** | Delivery pricing | **Configurable rules.** Pilot planning ranges: customer fee **KES 100–150**, rider payout **KES 70–100** for typical local deliveries. | Ranges are planning assumptions, **not** universal prices. Configurable by zone/distance/ops. Commission recorded **separately**; **5–12%** is a hypothesis to validate with merchants. Prices computed on backend; transparent breakdown shown pre-checkout. No promise every delivery is profitable. |
| **D6** | Payment timing | **Payment-first checkout** for online M-Pesa. | Create order + payment attempt in explicit **pending** state before STK Push. Do **not** dispatch until payment verified server-side **and** eligibility checks pass. Never trust app-reported status or an unverified callback. Idempotent callbacks; reconcile via provider refs + status queries. Configurable payment-expiry window. Verified-but-late payment on an expired/unfulfillable order → **tracked refund workflow**; refund not "complete" until confirmed. No promise of instant refunds unless the provider confirms it. Handle duplicates/timeouts/delays/ambiguity explicitly. |
| **D7** | Proof of delivery | **Customer delivery PIN** (default). | PIN generated securely; disclosed to customer only via an authenticated channel. Rider must submit correct PIN to complete. **Never stored in plaintext** — protected representation, attempt limits, expiry. Audited admin exception process for legitimate failures. Photo proof **optional/configurable**, not mandatory. |
| **D8** | Customer auth | **Kenyan phone number + OTP.** | Normalize to **E.164**. Design OTP issuance/expiry/retry limits/abuse-prevention/resend throttling. Short-lived access tokens + secure refresh strategy per client. RBAC enforced on backend. Phone verification ≠ legal identity. |
| **D10** | Merchant SLA & payment window | Merchant acceptance SLA **3 min** (configurable); M-Pesa checkout/payment window **2 min** (configurable). | Pilot defaults to validate vs. real Daraja + merchant ops. Timeout transitions explicit; a timeout must **never** silently create an unpaid or dispatchable order. Late success + merchant rejection must preserve the financial audit trail. **Rider-assignment timeout is separate** from merchant SLA. |
| **D11** | Mapping provider | **Google Maps Platform** (initial), subject to pricing/account/coverage validation. | Behind a **provider interface** so it can be swapped without touching order logic. Map route distance ≠ rider payout distance. Delivery-fee calc stays authoritative on backend. |
| **D12** | SMS/OTP provider | **Evaluate Africa's Talking and TalkSasa** for KE delivery/pricing/sender-ID/delivery-reports/reliability. | Behind a **notification interface** (replaceable). Production OTP must **not** depend on a dev mock. Dev-only OTP adapter; never log real production OTPs. |

### Engineering decisions

| ID | Decision |
|----|----------|
| E1 | **Modular monolith** for the MVP; no microservices. |
| E2 | **TypeScript** across all new application & backend code. |
| E3 | **MySQL** with reviewed migrations, explicit constraints, and transactional handling of critical order/payment operations. |
| E4 | **Data access = Knex** (migrations + query building). Resolved after review of migration safety, transactions/locking, maintainability, workflow. See [ADR-0001](0001-data-access-knex-over-prisma.md). |
| E5 | **No continuous background rider tracking** until foreground tracking, permissions, battery impact and real operational need are understood. Start with foreground-only. |
| E6 | **Real-time limited** to flows that need it (order tracking, offers, merchant alerts). |
| E7 | **Dispatch behind an interface** so assignment policy can evolve without rewriting order management. |
| E8 | **Financial records auditable**; a mutable balance field is never the sole source of financial truth (double-entry ledger is authoritative). |
| E9 | **Cash-flow dependency documented**: do not assume sufficient float to fund refunds/settlements; payouts depend on realized cash. |
| E10 | **Mock payment & notification providers** for automated tests, clearly separated from production integrations. |
| E11 | **No secrets or real personal data in the repo**, ever. |
| E12 | **Package manager / monorepo tooling: pnpm workspaces + Turborepo** (as approved in `02`). Pinned via `packageManager`. |

### Consequences for existing documents (reconciled 2026-10-17)

- `04-order-state-machine.md`: accept SLA 5→**3 min**, pay window 10→**2 min**; payment-first
  marked **decided**; proof-of-delivery = **PIN**.
- `03-data-model.md`: `delivery.proof_type` enum adds **`pin`** (default).
- `02-system-architecture.md`: ORM decision resolved to **Knex** (ADR-0001).
- `01-product-requirements.md`: launch town = **Migori**; customer auth = **phone-OTP**
  (confirmed); proof = **PIN**.
- `06-auth-and-authorization.md`: phone-OTP confirmed (assumption tag removed).
- `07-payments-and-reconciliation.md`: payment window **2 min**; refund-confirmation and
  cash-float caveats added.
- `08-rider-assignment-and-pricing.md`: pilot fee/payout ranges; Google Maps; route distance
  ≠ payout distance.
- `12-open-decisions-and-risks.md`: D1/D3/D6/D7/D8/D10/D11/D12 + ORM marked resolved.
