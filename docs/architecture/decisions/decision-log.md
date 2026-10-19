# Decision Log

Accepted decisions, most recent first. Values here are **authoritative**; the design
documents (`../01`…`../12`) are updated to match and point back here.

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
