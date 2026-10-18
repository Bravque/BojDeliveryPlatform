# 08 — Rider Assignment & Delivery Pricing

> Status: DRAFT for review.

## 1. Delivery pricing (server-authoritative)

Delivery fee is computed **server-side** at `POST /cart/quote` and re-computed and snapshotted
at order creation. The customer is shown a transparent breakdown before paying; it is never
client-supplied.

> **Pilot pricing ranges (D3).** Planning assumptions only, configurable per zone/distance/ops:
> customer delivery fee **KES 100–150**, rider payout **KES 70–100** for typical local Migori
> deliveries. These are **not** universal prices and we do **not** assume every delivery is
> profitable under them. Merchant commission (hypothesis **5–12%**, to validate) is tracked
> **separately** from the delivery fee.

### Formula (per active `delivery_fee_rule` for the resolved zone)
```
distance_m  = routing/haversine distance(merchant, delivery_address)
raw_fee     = base_fee_cents + ceil(distance_km) * per_km_cents
fee         = clamp(raw_fee, min_fee_cents, max_fee_cents?)
# optional surge/time multiplier (config, default 1.0)
fee         = round_to_cents(fee * surge_multiplier)
```
- Zone is resolved by point-in-polygon on `zone.boundary` for the delivery address; if the
  address is outside all served zones, checkout is blocked with a clear message.
- Distance uses **Google Maps Platform** (D11) distance matrix where available, behind a
  provider interface, with a **haversine fallback** if the provider is unavailable (fee
  computation must not hard-depend on an external call at checkout).
- **A map route distance is not the rider payout distance (D11).** Customer-fee distance and
  rider-payout distance are computed and stored independently; neither is assumed equal to the
  other or to the straight-line distance.
- The fee rule in effect is chosen by `effective_from/effective_to`; the chosen rule id is
  recorded for auditability.

### Rider fee (earnings) vs. customer delivery fee
These are **separate** figures. The customer pays `delivery_fee_cents`; the rider earns
`delivery.rider_fee_cents`. At launch, rider fee can be `delivery_fee − platform_delivery_margin`
or a distinct rider-rate table. **Who keeps the margin is an open decision (doc 12).** Both are
snapshotted so later rate changes don't rewrite history.

## 2. Rider assignment

### 2.1 Candidate selection
When an order reaches `ready_for_pickup` (or merchant-accepted, configurable), the assignment
service builds a ranked candidate list of riders who are:
- `rider_profile.status = approved` and `is_online = true`,
- recently pinged (`last_ping_at` within a freshness window),
- within a max radius of the merchant,
- not already on an active delivery (unless batching is enabled — not at launch),
- vehicle-type eligible for the order.

Ranking: primarily by proximity/ETA to the merchant, with tie-breakers (acceptance rate,
idle time for fairness). Ranking inputs are config-tunable.

### 2.2 Offer model & conflict resolution (the hard part)
We use **sequential (or small-batch) time-boxed offers** with an atomic accept:

```mermaid
sequenceDiagram
  participant ASG as Assignment service
  participant R1 as Rider A
  participant R2 as Rider B
  participant DB as MySQL/Redis
  ASG->>DB: create assignment_offer (rider=A, status=offered, expires_at)
  ASG-->>R1: offer.new (Socket.IO)
  R1->>ASG: POST /rider/offers/:id/accept
  ASG->>DB: TXN: lock order row; if order still ready & no accepted offer -> set offer=accepted, create/attach delivery(rider=A), order->rider_assigned
  DB-->>ASG: success (exactly one winner)
  ASG-->>R1: assignment.confirmed
  Note over ASG,R2: any competing accept hits the guard and gets 409; offer superseded
```

**Conflict guarantees:**
- Accept runs in a transaction that takes a **row lock on the order** (`SELECT … FOR UPDATE`)
  and asserts the order is still `ready_for_pickup` with no `accepted` offer. A unique
  partial constraint (one accepted offer per order / one delivery per order) backs this at
  the DB level.
- The first accept wins; concurrent accepts get `409 OFFER_ALREADY_TAKEN`.
- A short-lived **Redis lock** on `order:{id}:assign` reduces contention before hitting the DB
  (optimization only; the DB remains the source of truth).
- Unanswered offers `expire` and the next candidate is offered. Batch mode (offer to K riders
  at once) uses the same atomic accept to pick the single winner.

### 2.3 Rider cancel / no-show
- Pre-pickup rider cancel or no-show timeout → offer voided, `rider_assigned →
  ready_for_pickup`, re-enter candidate selection, rider flagged (metric).
- Post-pickup issues are ops-handled exceptions (doc 04), audited.

### 2.4 No rider available
- If candidates are exhausted, order stays `ready_for_pickup`, ops is alerted, and an SLA
  breach metric is recorded. Configurable retry/backoff before escalation.

## 3. Location & tracking
- Riders ping location while online (throttled REST or Socket.IO). Latest position stored on
  `rider_profile`; a short history may be kept for active deliveries only (privacy: not
  retained long-term for offline riders).
- Customer sees live rider location on the `order:{ulid}` room once assigned.

## 4. Fairness & abuse considerations
- Acceptance-rate and completion metrics feed ranking without hard-locking new riders out.
- Guard against offer "sniping" and gaming via rate limits and audit.
- Surge/zone multipliers are Ops-controlled and audited, not automatic ML at launch.

## 5. Future-proofing
- Batching multiple orders per rider, multi-pickup, and scheduled deliveries are additive:
  the offer/accept atomicity and `delivery` model already isolate the single-order case.

## 6. Acceptance criteria

- [ ] Delivery fee computed server-side; identical inputs → identical fee; outside-zone
      address blocks checkout.
- [ ] Maps outage → haversine fallback still produces a fee (no hard dependency at checkout).
- [ ] Concurrency test: K riders accept the same offer simultaneously → exactly one wins,
      others get `409`.
- [ ] Offer expiry re-offers to the next candidate; exhaustion escalates to ops.
- [ ] Rider fee and customer delivery fee are stored separately and snapshotted on the order/delivery.
