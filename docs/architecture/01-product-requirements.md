# 01 — Product Requirements Document (PRD)

> Status: DRAFT for review. Assumptions are tagged **[ASSUMPTION]** and collected in
> `12-open-decisions-and-risks.md`.

## 1. Vision

A reliable, trustworthy multi-category delivery marketplace for a single Kenyan town at
launch, connecting **customers**, **merchants**, and **independent riders**, with M-Pesa
payments and transparent settlement. The platform must be correct about money and order
state before it is feature-rich.

## 2. Personas

| Persona | Primary goals | Key constraints |
|---------|---------------|-----------------|
| **Customer** | Browse merchants, build a cart, pay via M-Pesa, track delivery | Variable connectivity, STK-push latency, wants accurate ETAs & fees |
| **Merchant operator** | Receive & accept orders, manage catalogue/stock, get settled | Needs fast order notifications; may be a single-person shop |
| **Rider (independent)** | Get offered nearby jobs, navigate, confirm handoff, get paid | Owns their vehicle; comes online/offline; limited data |
| **Admin / Ops** | Configure zones/fees/commissions, resolve disputes, reconcile money, run reports | Needs audit trail and override controls |
| **Finance** | Reconcile M-Pesa vs. ledger, approve payouts, handle refunds | Needs immutable financial records |

## 3. In-scope (Launch / Phase 1–3)

- Single launch town — **Migori, Kenya** (compact Migori Town/CBD service area, D1) — one
  delivery operating area subdivided into configurable **delivery zones** (DB records; no
  hardcoded boundaries, not every address is serviceable).
- **One merchant per order** (one cart → one merchant).
- Product catalogue with categories, products, options/variants, stock, availability.
- Cart → checkout → order lifecycle with a strict state machine.
- Delivery fee computed from zone + distance **server-side**.
- M-Pesa STK push (Daraja) — **simulated** until production credentials exist.
- Independent rider onboarding, online/offline, job offer/accept, delivery confirmation.
- Payment records, merchant settlements, rider earnings, refunds (full & partial).
- Promotions (basic: percentage / fixed / free-delivery with caps and eligibility).
- Admin dashboard: merchants, catalogue moderation, zones/fees, commissions, disputes, reports.
- Audit logging of security- and money-relevant events.

## 4. Out-of-scope at launch (designed-for, not built)

Multi-town; multi-merchant baskets; scheduled/pre-orders; card/wallet payments; employed
rider fleets & shifts; loyalty points; subscriptions; ratings-driven ranking ML; customer-to-
customer parcels. Data model leaves room for these (see `03-data-model.md`).

## 5. Functional requirements (by domain)

### 5.1 Customer
- FR-C1 Register/login via Kenyan phone number + OTP, normalized to E.164 (decided D8).
- FR-C2 Browse merchants filtered by category and by whether the customer address is in a served zone.
- FR-C3 View products with price, availability, options; add to cart (single merchant).
- FR-C4 See itemized order total: subtotal + delivery fee + service fee (if any) − promotions, computed server-side.
- FR-C5 Place order and trigger M-Pesa STK push; see live payment status.
- FR-C6 Track order through states with live rider location once assigned.
- FR-C7 Cancel within allowed window/states; request refund per policy.
- FR-C8 View order history and receipts.

### 5.2 Merchant
- FR-M1 Manage catalogue: categories, products, options, prices, stock, availability windows.
- FR-M2 Receive new-order notification; **accept/reject within an SLA timer**.
- FR-M3 Mark order preparing → ready-for-pickup.
- FR-M4 Set open/closed status and preparation time estimate.
- FR-M5 View settlement statements and payout history.

### 5.3 Rider
- FR-R1 Onboard (KYC documents, vehicle type) with admin approval gate.
- FR-R2 Go online/offline; share location while online.
- FR-R3 Receive job offer with pickup/dropoff, fee, distance; accept/decline within a timer.
- FR-R4 Navigate to merchant, confirm pickup, navigate to customer, and confirm delivery by
  verifying the **customer delivery PIN** (decided D7); photo proof optional/configurable.
- FR-R5 View earnings ledger and payout history.

### 5.4 Admin / Ops / Finance
- FR-A1 Configure zones, delivery fee rules, service fees, commission rates, promotions.
- FR-A2 Approve/suspend merchants and riders.
- FR-A3 View every order, intervene (reassign rider, cancel, refund) with reason + audit.
- FR-A4 Reconcile M-Pesa transactions against the ledger; flag mismatches.
- FR-A5 Approve settlement and payout batches.
- FR-A6 Reports: GMV, order volume, cancellation/refund rates, rider utilization, zone performance.

## 6. Non-functional requirements

| Area | Requirement |
|------|-------------|
| **Correctness** | No lost/duplicated money events; order state transitions are atomic and audited. |
| **Availability** | Target 99.5% for order & payment paths at launch (single-region) **[ASSUMPTION]**. |
| **Latency** | p95 API < 400ms for reads; checkout < 1.5s excluding M-Pesa round-trip. |
| **Scalability** | Design for 10× launch volume without schema rewrite; stateless API tier. |
| **Security** | RBAC server-side; least privilege; secrets never in repo; audit logs. |
| **Data protection** | Kenya **Data Protection Act 2019** alignment: consent, minimization, subject-access, retention policy. |
| **Observability** | Structured logs, request IDs, metrics on payment/order funnels, alerting. |
| **Resilience** | Idempotent callbacks; reconciliation job; backups with tested restore. |
| **Accessibility/Localization** | English at launch; currency KES; **[ASSUMPTION: Swahili deferred]**. |
| **Connectivity** | Mobile apps tolerate intermittent connectivity; offline-safe cart; retry-safe actions. |

## 7. Success metrics (launch)

- Payment success rate (STK completed / initiated) and reconciliation match rate ≥ 99%.
- Order completion rate; median time-to-accept (merchant) and time-to-assign (rider).
- Cancellation & refund rates within target thresholds (to be set with Ops).
- Zero unexplained money discrepancies in weekly reconciliation.

## 8. Constraints & dependencies

- Safaricom Daraja availability and credential provisioning (sandbox first).
- Maps provider quota/billing (Google Maps or Mapbox — see `12-open-decisions-and-risks.md`).
- SMS/OTP provider and push-notification service selection.
- Legal: merchant/rider contracts, consumer refund policy, data-protection registration.

## 9. Acceptance criteria for the PRD itself

- [x] Launch town confirmed (**Migori**) and zones modeled as configurable records (D1).
- [~] Delivery-fee/payout ranges set as pilot assumptions (D3); **commission 5–12% remains a
  hypothesis to validate with merchants** before go-live.
- [ ] Refund & cancellation policy (D9) approved by Ops/Legal — still open.
- [x] Proof-of-delivery method chosen: **customer PIN** (D7).
- [x] Customer auth confirmed: **phone + OTP** (D8).
