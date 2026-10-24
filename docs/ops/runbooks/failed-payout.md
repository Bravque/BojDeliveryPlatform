# Runbook — Failed / stuck payout (B2C)

**Symptom:** a settlement is approved but the payout is stuck `processing` or marked `failed`; a
rider/merchant reports not being paid.

**Model recap:** payouts are dual-signed (finance **and** ops, two distinct users) before execute,
then a B2C `PaymentRequest` goes to Safaricom; the async result arrives at
`POST /api/v1/webhooks/mpesa/b2c-result` and `applyB2cResult` dedupes it (`payout_event`), matches
the payout by `external_ref` (the Daraja `ConversationID`), and idempotently confirms: success →
`DR merchant_payable|rider_payable / CR mpesa_clearing` + source settlement `paid`; failure →
`failed`. Replays are no-ops.

## Diagnose

1. Inspect the payout: `GET /api/v1/admin/payouts/:ulid` (and `GET /api/v1/admin/payouts`).
   - Not executed? Check both approvals landed: `approve-finance` **and** `approve-ops`.
   - Executed but still `processing`? The B2C result webhook likely never arrived.
2. Check `payout_event` rows for the payout (raw B2C results + dedupe) and whether the result
   webhook is reachable: URL = `DARAJA_B2C_RESULT_URL`, protected by `X-Webhook-Token`
   (`MPESA_WEBHOOK_TOKEN`) + optional `DARAJA_WEBHOOK_IP_ALLOWLIST`.

## Remediate

- **Missing result callback:** confirm `DARAJA_B2C_RESULT_URL` is registered with Safaricom and
  publicly reachable; verify the token/IP allow-list isn't rejecting (403). Once Safaricom
  re-delivers (or you re-request), `applyB2cResult` confirms idempotently.
- **`failed`:** read the B2C `ResultCode`/`ResultDesc` in the `payout_event`. Fix the cause (e.g.
  invalid payee MSISDN, insufficient float) and re-generate/re-execute the payout for that
  payee+period (generation is idempotent per payee+period).

## Known gap — merchant destination

A **merchant** payout has **no destination modelled** (payee MSISDN is resolved from
`user.phone_e164`, riders only). A merchant B2C execute errors "no destination". Until a
payout-destination field exists, settle merchants out-of-band and record it. See
`daraja-cutover.md` §4 and `go-live-checklist.md`.

## Verify

- `GET /api/v1/admin/payouts/:ulid` → `paid`; payable account cleared for that payee;
  `GET /api/v1/admin/reports/ledger` imbalance flag false.

## Escalate

- Never pay twice: confirmation is idempotent by `payout:{id}` / `external_ref` — if unsure, check
  the ledger before any manual action, and never hand-post entries.
- Float/initiator-credential errors → finance + `daraja-cutover.md`.
