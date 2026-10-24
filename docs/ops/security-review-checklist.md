# Security review checklist (Phase 8 sign-off)

**Status: requires human review sign-off.** This maps each item to what the codebase already
enforces so a reviewer can verify rather than rediscover. Tick only after independent review.
Reviewer + date go at the bottom.

## Authentication & sessions

- [ ] Dashboard passwords hashed with **argon2id**; account lockout after
      `PASSWORD_MAX_ATTEMPTS` for `PASSWORD_LOCKOUT_SEC`.
- [ ] Phone-OTP throttled (MySQL-backed): `OTP_MAX_PER_PHONE`, `OTP_MAX_PER_IP`,
      `OTP_MAX_ATTEMPTS`, TTL; codes hashed with `OTP_PEPPER` (≥16 chars).
- [ ] Access tokens **RS256**; private key only in the secret manager; short TTL
      (`ACCESS_TOKEN_TTL_SEC`).
- [ ] Refresh-token **rotation with reuse detection** active.
- [ ] No user-enumeration on login/OTP (uniform responses).

## Authorization

- [ ] RBAC enforced **on the backend** for every mutating route (role + ownership + separation of
      duties), not in the UI.
- [ ] Separation of duties holds where required: refund requester ≠ approver; payout dual-sign
      needs **two distinct** users (finance + ops).
- [ ] Append-only `audit_log`; app DB role has **no DELETE/UPDATE on `audit_log`**.

## Money integrity

- [ ] Server is the source of truth for all prices/fees/commission; **no client-supplied**
      price/commission/payment-status is trusted.
- [ ] Payment & B2C callbacks verified (`X-Webhook-Token`, optional source-IP allow-list) and
      **deduplicated** (`payment_event` / `payout_event`); replays are idempotent.
- [ ] Amount-mismatch payments are **quarantined, not captured**.
- [ ] Critical financial/order operations run in DB transactions; double-entry ledger stays
      balanced (`GET /admin/reports/ledger` imbalance flag false).

## HTTP hardening (Phase 8 Inc 1)

- [ ] `helmet` security headers set; `x-powered-by` removed.
- [ ] Per-IP rate limiting: global cap + stricter `/api/v1/auth` cap → `RATE_LIMITED` 429.
- [ ] CORS restricted to `CORS_ALLOWED_ORIGINS` (empty = same-origin only).
- [ ] `TRUST_PROXY` set to the real number of proxy hops (correct client IPs; rate-limit keys).
- [ ] TLS terminated at the edge; HTTPS enforced.

## Secrets & infrastructure

- [ ] No credentials or production personal data in the repo/history (`.env` is examples only).
- [ ] Daraja keys, DB creds, JWT keys, SMS/maps keys in a **secret manager** with rotation.
- [ ] Least-privilege DB roles: app role limited DDL; migrations run under a separate role.
- [ ] Production access role-gated, MFA-protected, audited.
- [ ] `DARAJA_WEBHOOK_IP_ALLOWLIST` set in production.

## Logging & monitoring

- [ ] Structured logs with `X-Request-Id`; security-relevant events logged; **no secrets/PII in
      logs**.
- [ ] Alerts wired for ledger imbalance, reconciliation mismatch, payment success-rate drop,
      migration failure, backup/restore-drill failure (DR doc §8).

## Dependencies

- [ ] Dependency vulnerability scan clean (or triaged) at the release SHA.

---

**Known accepted gap:** merchant B2C payout destination not modelled — merchant payouts are
blocked under Daraja until added (see `runbooks/daraja-cutover.md` §4).

**Sign-off:** reviewer __________________ date __________ result: PASS / FAIL / CONDITIONAL
