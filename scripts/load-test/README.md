# Load test (k6)

`order-flow.js` is a [k6](https://k6.io) script that exercises the hottest read path (health →
`GET /merchants?townName=…` → `GET /merchants/:ulid/catalogue`, response envelope
`{ items: [...] }`) and is sized to ramp to **10× the launch-volume projection**, satisfying the
Phase 8 acceptance box _"Load test meets latency/throughput targets at 10× launch volume
projection"_ (`docs/architecture/11-delivery-phases-and-acceptance.md`).

> **Operator-run.** k6 runs against a **deployed** API. There is no deployed environment on the
> dev sandbox, so this test **cannot be executed here** — run it against `staging` (Daraja
> sandbox), sized like production. Never run a load test against production without sign-off.

## Prerequisites

- Install the k6 binary: <https://grafana.com/docs/k6/latest/set-up/install-k6/>
- A reachable API base URL (e.g. `https://staging.api.boj.co.ke/api/v1`).
- Seeded synthetic catalogue data in the target env (use `pnpm db:seed`; CLAUDE.md: synthetic
  data only — never real personal data in a test).

## Run

```bash
k6 run \
  -e BASE_URL=https://staging.api.boj.co.ke/api/v1 \
  -e LAUNCH_RPS=5 \
  -e TOWN=Migori \
  scripts/load-test/order-flow.js
```

| Env | Meaning | Default |
|-----|---------|---------|
| `BASE_URL` | API base, including `/api/v1` | `http://localhost:4000/api/v1` |
| `LAUNCH_RPS` | Launch-volume browse rate (req/s); the test ramps to **10×** this | `5` |
| `TOWN` | Town filter for the public browse | `Migori` |
| `ACCESS_TOKEN` | Optional bearer token for authenticated reads | _(none)_ |

The profile ramps `LAUNCH_RPS → 10×` over ~9 minutes (1m baseline, 2m ramp, 5m soak at 10×, 1m
ramp-down).

## Pass/fail thresholds (`options.thresholds`)

| Threshold | Target |
|-----------|--------|
| `http_req_failed` | < 1% failed requests at 10× |
| `http_req_duration` | p95 < 800 ms, p99 < 1.5 s |
| `boj_errors` | < 1% |

k6 exits non-zero if any threshold is breached — wire that into the go-live gate. **Confirm these
targets with Product/Ops before sign-off** and adjust `LAUNCH_RPS` to the agreed projection.

## Recording the result

Capture the k6 end-of-test summary (or `--out json=results.json` / `k6 cloud`) and attach it to the
Phase 8 go-live record (`docs/ops/go-live-checklist.md`). The acceptance box stays **"requires
execution"** until a real run against staging is recorded here.

## Scope / extending

This script covers the read-heavy entry path, which is where concurrency pressure first shows.
Write/order-placement load (cart → `POST /orders` → `POST /orders/:ulid/pay`) requires per-VU auth
tokens and real stock, and mutates data — add it as a separate authenticated scenario against a
disposable staging dataset before extending the gate to the write path.
