# Runbook — Rider assignment stall

**Symptom:** orders are `ready` (or awaiting a rider) but offers aren't progressing — no rider is
being assigned, or offers aren't expiring/re-offering.

**Model recap:** when an order is marked ready it triggers a time-boxed offer to a candidate
rider. A rider accepts atomically (first-wins; losers get 409 `OFFER_ALREADY_TAKEN`). Stale offers
are expired and re-offered by an assignment **tick**. The scheduler runs the tick every
`OFFER_TICK_INTERVAL_SEC` when `SCHEDULER_ENABLED=true`.

## Diagnose

1. Is the scheduler running on exactly one instance? (`scheduler-and-redis.md`.) If off/lagging,
   offers won't expire or re-offer on their own.
2. Are there eligible riders? Assignment needs **approved** riders who are **online** (presence:
   `POST /rider/online` + `ping`). No online riders → nothing to offer to.
3. Inspect open offers/deliveries for the order (assignment/`delivery` tables) and rider offer
   feed (`GET /rider/offers`).

## Remediate

Force an expiry/re-offer tick (idempotent):
```
POST /api/v1/admin/assignments/tick        (auth: admin/ops)
```
This expires stale offers and re-offers to the next candidate. If no riders are online, the
remedy is operational (get riders online), not technical.

## Verify

- The order gets an active offer and then a rider acceptance; `delivery` row progresses
  (offered → accepted → …). `GET /api/v1/admin/reports/summary` rider-utilization reflects it.

## Escalate

- Offers created but never accepted despite online riders → check candidate-selection config
  (rider fee rate / platform margin, D15) and realtime delivery (`scheduler-and-redis.md` for the
  Redis adapter if multi-instance).
- Thrashing re-offers → lower cadence pressure by confirming only one scheduler instance runs.
