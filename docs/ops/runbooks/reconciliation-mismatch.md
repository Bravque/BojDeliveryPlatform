# Runbook — Reconciliation mismatch / ledger imbalance

**Symptom:** a ledger-imbalance or reconciliation-mismatch alert fires (DR doc §8), or a payment
was quarantined for amount mismatch. **The ledger is the source of truth — never hand-edit it.**

## Two distinct checks

1. **Internal invariant — ledger balance.** Every `ledger_transaction` must have
   `SUM(debit amount) = SUM(credit amount)` across its `ledger_entry` rows (schema: positive
   `amount_cents` + `direction` enum). Surfaced by:
   ```
   GET /api/v1/admin/reports/ledger        (auth: audit:read)
   ```
   The response carries a per-account natural-balance list **plus an imbalance flag** backed by
   `findImbalancedTransactions`. Flag **true** = a bug or bad manual write — this must always be
   false in a healthy system.
2. **External divergence — Daraja vs ledger.** Payments where our state and Safaricom's differ,
   including **amount-mismatch quarantines** (gateway reported a different amount than the order):
   ```
   GET /api/v1/admin/payments/reconciliation-report
   ```

## Diagnose & remediate

- **Imbalance flag true:** freeze payouts/settlements for the affected period; identify the
  offending transaction(s) from the report; this is an engineering incident — do **not** post a
  "correcting" entry blindly. Root-cause the code path that wrote the unbalanced transaction.
- **Amount-mismatch quarantine:** the payment was **not** captured (by design). Compare the order
  total vs the gateway amount. If the gateway is right and the order wrong, cancel/refund per
  `stuck-payment.md`/refund flow; if ours is right, treat as a Daraja discrepancy and raise with
  Safaricom. Resolve via the reconcile sweep (`POST /admin/payments/reconcile`), never a manual
  ledger edit.
- **Divergence (pending/mismatch):** run the sweep (`stuck-payment.md`); it re-queries Daraja and
  captures/fails idempotently.

## Verify

- `GET /api/v1/admin/reports/ledger` imbalance flag **false**.
- `GET /api/v1/admin/payments/reconciliation-report` shows no unresolved divergence/quarantine.

## Escalate

- Persistent imbalance → engineering on-call + finance; keep an audit trail; the append-only
  `audit_log` and `payment_event`/`payout_event` tables are your evidence.
