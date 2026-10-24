# Runbook — Daraja (M-Pesa) cutover

**Audience:** release engineer + finance/ops approver. **Scope:** switch payments from the
simulated gateway to real Safaricom Daraja, sandbox → production. This is a **deploy-time config
flip** — no code change (Phase 8 acceptance: _"switching `PAYMENT_PROVIDER` to Daraja requires no
changes outside the adapter"_). Adapters: `payments/daraja/` (STK) + `payouts/daraja/` (B2C).

## Order of cutover

Always prove **`daraja_sandbox`** on staging before **`daraja_prod`**.

## 1. Configure secrets (secret manager, never the repo)

Money-in (STK) and money-out (B2C) share one Daraja app. Set, required-when-Daraja (zod refine
rejects boot if any is missing):

| Var | Notes |
|-----|-------|
| `PAYMENT_PROVIDER` | `daraja_sandbox` then `daraja_prod` |
| `DARAJA_BASE_URL` | `https://sandbox.safaricom.co.ke` → `https://api.safaricom.co.ke` |
| `DARAJA_CONSUMER_KEY` / `DARAJA_CONSUMER_SECRET` | OAuth app creds |
| `DARAJA_SHORTCODE` / `DARAJA_PASSKEY` | STK Lipa-na-M-Pesa shortcode + passkey |
| `DARAJA_CALLBACK_URL` | `https://api.<domain>/api/v1/webhooks/mpesa/stk` |
| `DARAJA_INITIATOR_NAME` / `DARAJA_INITIATOR_PASSWORD` | B2C initiator |
| `DARAJA_SECURITY_CERT` | Safaricom public cert (PEM, one line with `\n`); used to build the `SecurityCredential` |
| `DARAJA_B2C_SHORTCODE` | B2C paying shortcode |
| `DARAJA_B2C_RESULT_URL` | `https://api.<domain>/api/v1/webhooks/mpesa/b2c-result` |
| `DARAJA_B2C_TIMEOUT_URL` | `https://api.<domain>/api/v1/webhooks/mpesa/b2c-timeout` |
| `MPESA_WEBHOOK_TOKEN` | shared secret the callbacks must send as `X-Webhook-Token` |
| `DARAJA_WEBHOOK_IP_ALLOWLIST` | (optional, recommended in prod) comma-separated Safaricom source IPs |

## 2. Register URLs with Safaricom

Register the **STK callback**, **B2C result**, and **B2C timeout** URLs in the Daraja portal for
the shortcode. They must be public HTTPS and match the env values exactly.

## 3. Deploy & smoke (sandbox first)

1. Deploy with the sandbox config (`deploy.md`). Confirm boot (config valid) + `GET /health`.
2. **STK smoke:** place a test order → `POST /orders/:ulid/pay` → complete the STK prompt on a
   sandbox test MSISDN → confirm Safaricom calls `POST /api/v1/webhooks/mpesa/stk` → payment
   captured, order `placed`/paid, ledger balanced. Amount is sent in **whole shillings**
   (cents/100; the adapter rejects non-whole). Callback is deduped via `payment_event`.
3. **B2C smoke:** generate + dual-sign + execute a **rider** payout (`failed-payout.md`) → confirm
   `POST /api/v1/webhooks/mpesa/b2c-result` → payout `paid`, `rider_payable` cleared,
   `payout_event` row written.

## 4. Known gap — merchant B2C destination

**Merchant** payout destination (MSISDN/till) is **not modelled** — B2C resolves the payee from
`user.phone_e164`, which only exists for riders. Executing a **merchant** payout under Daraja will
error "no destination". Treat merchant payouts as **blocked** until a payout-destination field is
added, or settle merchants out-of-band. This is an explicit go/no-go item (`go-live-checklist.md`).

## 5. Production flip

Repeat §1–3 with prod `DARAJA_BASE_URL` + production creds + prod callback URLs, after sandbox
sign-off. Keep `DARAJA_WEBHOOK_IP_ALLOWLIST` set in prod.

## Rollback

Set `PAYMENT_PROVIDER=simulated` and redeploy — `buildGateway()` returns the `SimulatedGateway`;
no other change. In-flight Daraja payments already captured stay captured (ledger is truth); the
stale-payment reconcile sweep + `POST /admin/payments/reconcile` resolve anything mid-flight.

## Verify / escalate

- Verify: one real sandbox STK capture + one rider B2C confirm visible in the ledger and in
  `GET /admin/reports/ledger` with the imbalance flag **false**.
- Escalate: repeated callback 403s → check token / IP allow-list; OAuth failures → check consumer
  key/secret + `DARAJA_BASE_URL`; amount-mismatch quarantines → `reconciliation-mismatch.md`.
