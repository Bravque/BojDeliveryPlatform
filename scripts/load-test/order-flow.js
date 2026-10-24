// k6 load test for the BojDelivery read + order path.
//
// Runs under the k6 runtime (https://k6.io), NOT Node — hence k6/* imports and __ENV globals,
// and why this directory is excluded from the repo's eslint/prettier config. OPERATOR-RUN: point
// it at a staging deployment (Daraja sandbox) sized like production; do not run it against the
// dev sandbox (no deployed API) and never against production without sign-off.
//
// Goal: sustain ~10x the launch-volume projection and confirm latency/throughput thresholds
// (docs/architecture/11-delivery-phases-and-acceptance.md, Phase 8). Tune LAUNCH_RPS to the
// agreed launch projection; the stages below ramp to 10x that number.
//
// Run:
//   k6 run -e BASE_URL=https://staging.api.boj.co.ke/api/v1 \
//          -e LAUNCH_RPS=5 \
//          -e TOWN=Migori \
//          scripts/load-test/order-flow.js
//
// Optional auth for authenticated read endpoints:
//   -e ACCESS_TOKEN=eyJhbGc...   (a staging customer/admin bearer token)

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:4000/api/v1').replace(/\/$/, '');
const TOWN = __ENV.TOWN || 'Migori';
const ACCESS_TOKEN = __ENV.ACCESS_TOKEN || '';

// Launch projection in requests/sec for the browse path; the test ramps to 10x this.
const LAUNCH_RPS = Number(__ENV.LAUNCH_RPS || 5);
const PEAK_RPS = LAUNCH_RPS * 10;

const errorRate = new Rate('boj_errors');
const browseLatency = new Trend('boj_browse_latency', true);

export const options = {
  scenarios: {
    browse_and_quote: {
      executor: 'ramping-arrival-rate',
      startRate: LAUNCH_RPS,
      timeUnit: '1s',
      preAllocatedVUs: Math.max(50, PEAK_RPS),
      maxVUs: Math.max(200, PEAK_RPS * 4),
      stages: [
        { target: LAUNCH_RPS, duration: '1m' }, // baseline (launch volume)
        { target: PEAK_RPS, duration: '2m' }, // ramp to 10x
        { target: PEAK_RPS, duration: '5m' }, // hold at 10x (soak)
        { target: 0, duration: '1m' }, // ramp down
      ],
    },
  },
  // Launch latency/throughput targets. Adjust with Product/Ops before sign-off.
  thresholds: {
    http_req_failed: ['rate<0.01'], // <1% failed requests at 10x
    http_req_duration: ['p(95)<800', 'p(99)<1500'], // p95 < 800ms, p99 < 1.5s
    boj_errors: ['rate<0.01'],
    boj_browse_latency: ['p(95)<800'],
  },
};

function authHeaders() {
  const headers = { Accept: 'application/json' };
  if (ACCESS_TOKEN) headers.Authorization = `Bearer ${ACCESS_TOKEN}`;
  return headers;
}

export default function () {
  // 1) Health — cheap liveness signal under load.
  const health = http.get(`${BASE_URL.replace(/\/api\/v1$/, '')}/health`, {
    headers: { Accept: 'application/json' },
  });
  check(health, { 'health 200': (r) => r.status === 200 });

  // 2) Public catalogue browse (approved/open merchants for the launch town) — the hottest
  //    read path and the realistic entry point for a customer. Returns { items: [...] }.
  const browse = http.get(`${BASE_URL}/merchants?townName=${encodeURIComponent(TOWN)}`, {
    headers: authHeaders(),
    tags: { name: 'browse_merchants' },
  });
  browseLatency.add(browse.timings.duration);
  const browseOk = check(browse, {
    'browse 2xx': (r) => r.status >= 200 && r.status < 300,
  });
  errorRate.add(!browseOk);

  // 3) Follow one merchant's catalogue when the browse returned data (best-effort — only assert
  //    when we actually got merchants back in the { items: [...] } envelope).
  try {
    const body = browse.json();
    const list = body && body.items;
    if (Array.isArray(list) && list.length > 0 && list[0] && list[0].ulid) {
      const cat = http.get(`${BASE_URL}/merchants/${list[0].ulid}/catalogue`, {
        headers: authHeaders(),
        tags: { name: 'merchant_catalogue' },
      });
      errorRate.add(!check(cat, { 'catalogue 2xx': (r) => r.status >= 200 && r.status < 300 }));
    }
  } catch (_e) {
    // Non-JSON / unexpected shape under load still counts via errorRate above.
  }

  sleep(1);
}
