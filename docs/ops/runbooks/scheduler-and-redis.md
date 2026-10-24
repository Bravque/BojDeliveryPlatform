# Runbook — Scheduler & Redis socket adapter

**Scope:** operating the in-process background scheduler and scaling Socket.IO across instances.
Both are flag-gated and add **no new infra** unless you opt in (D18).

## Scheduler

An in-process interval runner (`platform/scheduler/scheduler.ts`) drives two idempotent jobs:

| Job | What it does | Cadence env |
|-----|--------------|-------------|
| reconcile sweep | `reconcileStalePayments` over payments older than `RECONCILE_OLDER_THAN_SEC` | every `RECONCILE_INTERVAL_SEC` |
| assignment tick | `assignmentService.tick()` — expire/re-offer stale rider offers | every `OFFER_TICK_INTERVAL_SEC` |

A failing run is logged and swallowed (one bad run never kills the loop or the other job).

### Enable — exactly ONE instance

```
SCHEDULER_ENABLED=true
RECONCILE_INTERVAL_SEC=120
RECONCILE_OLDER_THAN_SEC=120
OFFER_TICK_INTERVAL_SEC=15
```

> **Critical:** enable on **exactly one** instance. Running it on multiple app instances is safe
> for correctness (both jobs are idempotent — they won't double-capture or double-pay) but wastes
> DB work and causes offer thrash. Keep all other instances `SCHEDULER_ENABLED=false`. Durable
> multi-instance queues (BullMQ, a dedicated worker tier) are deferred to a later multi-instance
> deploy (DR doc §2).

The scheduler starts after `httpServer.listen` and stops on graceful shutdown.

## Redis socket adapter (horizontal scale for realtime)

Socket.IO defaults to a single in-memory instance. Set `REDIS_URL` and the app attaches the Redis
adapter (`attachScaleAdapter`) so room emits fan out across all instances:

```
REDIS_URL=redis://host:6379
```

Unset → single in-memory instance (fine for one app node). The Redis-attached path is exercised at
deploy time, not in CI. Order/money truth is always in MySQL; Redis loss only drops ephemeral
pub/sub (clients reconnect and re-join rooms).

## Verify

- Scheduler: with it on, a stale `payment_pending` resolves without a manual
  `POST /admin/payments/reconcile`, and stale offers expire without a manual
  `POST /admin/assignments/tick`. Logs show periodic job runs.
- Redis: with `REDIS_URL` set and ≥2 instances, an event emitted on instance A reaches a client
  connected to instance B (e.g. a merchant sees `order.new` regardless of which node it hit).

## Escalate

- Jobs not firing → confirm `SCHEDULER_ENABLED=true` on the one instance and the interval envs are
  sane (> 0). Repeated job errors in logs → open the relevant incident runbook (stuck-payment /
  rider-assignment-stall).
- Realtime not fanning out across instances → check `REDIS_URL` reachability from every instance.
