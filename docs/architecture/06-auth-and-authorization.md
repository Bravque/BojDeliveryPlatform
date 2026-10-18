# 06 — Authentication & Authorization

> Status: DRAFT for review.

## 1. Identity model

- **Primary identity is the phone number (E.164)**, reflecting Kenyan norms and M-Pesa
  alignment. Email/password is optional and mainly for dashboard (merchant/admin) users.
  **Decided (D8, 2026-10-17):** phone + OTP for customers/riders; numbers normalized to
  E.164. Phone verification establishes an account, **not** legal identity.
- One `user` can hold **multiple roles** (e.g. a person who is both customer and rider).
  Roles: `customer`, `rider`, `merchant_owner`, `merchant_staff`, `admin`, `ops`, `finance`.
- Dashboard users (admin/finance/ops, merchant staff) use email + password **plus**
  optional OTP/2FA; customers and riders use phone + OTP.

## 2. Authentication flows

### 2.1 Customer / rider — phone OTP
1. `POST /auth/otp/request { phone }` → server rate-limits, generates a 6-digit code, stores
   a **hash** with short expiry, sends via SMS provider. Response reveals nothing about
   whether the number exists.
2. `POST /auth/otp/verify { phone, code }` → verify hash, expiry, attempt count → issue
   tokens. First successful verify provisions a `user` + `customer`/`rider` as appropriate.

### 2.2 Dashboard — email + password (+ optional TOTP)
- Argon2id password hashing. Optional TOTP 2FA for admin/finance (recommended mandatory for
  finance). Account lockout + backoff on repeated failures.

### 2.3 Tokens
- **Access token:** short-lived JWT (~15 min), signed (RS256/EdDSA), claims: `sub` (user
  ulid), `roles`, `scope`, `jti`, `exp`. Stateless verification at the API tier.
- **Refresh token:** opaque, long-lived (~30 days), stored **hashed** in `refresh_token`
  with a `family_id` for **rotation + reuse detection** (reuse of a rotated token revokes the
  whole family and forces re-auth).
- Logout revokes the presented refresh token (and optionally the family).
- Mobile stores tokens in secure storage (Expo SecureStore / Keychain / Keystore), never in
  plain AsyncStorage.

## 3. Authorization model (RBAC + resource ownership)

Authorization is **always enforced server-side** (CLAUDE.md). Two layers:

1. **Role gate** — does the principal hold a role permitted for this action?
2. **Resource ownership / relationship check** — does the principal own or relate to *this
   specific* resource?

Both must pass. The UI may hide controls, but that is never the enforcement point.

### 3.1 Permission matrix (representative)

| Action | customer | rider | merchant | admin | ops | finance |
|--------|:-:|:-:|:-:|:-:|:-:|:-:|
| Browse catalogue | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manage own cart / place order | ✓ | – | – | – | – | – |
| Pay / cancel own order (pre-accept) | ✓(own) | – | – | ✓ | ✓ | – |
| Accept/reject/prepare/ready order | – | – | ✓(own) | ✓ | ✓ | – |
| Manage own catalogue/inventory | – | – | ✓(own) | ✓ | – | – |
| Accept delivery offer / confirm pickup/deliver | – | ✓(assigned) | – | ✓ | ✓ | – |
| Configure zones/fees/commissions/promos | – | – | – | ✓ | ✓(limited) | – |
| Approve refunds | – | – | – | ✓ | ✓(limited) | ✓ |
| Generate/approve settlements & payouts | – | – | – | ✓ | – | ✓ |
| View audit logs | – | – | – | ✓ | ✓(read) | ✓(read) |
| Reassign rider / force transition | – | – | – | ✓ | ✓ | – |

"own"/"assigned" denotes the ownership check layer.

### 3.2 Ownership checks (examples)
- Order read: `customer_id == me` OR `merchant staff of order.merchant_id` OR
  `delivery.rider_id == me` OR admin/ops.
- Merchant catalogue write: `merchant_user(merchant_id, me)` exists with sufficient role.
- Rider delivery action: `delivery.rider_id == me` AND order in the right state.

### 3.3 Implementation
- A `policy` layer per module exposes `can(principal, action, resource)` used by controllers.
- Middleware resolves the principal (JWT → roles), then the controller invokes the relevant
  policy before the service call. Policies are **unit-tested** independently.
- Separation of duties: the user who **requests** a refund/payout cannot be the one who
  **approves** it (enforced for finance actions).

## 4. Sensitive-action controls

- Refunds, payouts, commission changes, forced order transitions, and role grants require:
  elevated role, a **reason**, and an **audit_log** entry with before/after.
- Admin "act-as"/impersonation (if ever added) is explicit, time-boxed, and fully audited.

## 5. Security hardening

- HTTPS everywhere; HSTS on web dashboards.
- CSRF: dashboards use `Authorization` header tokens (not cookies) → CSRF surface minimal;
  if cookies are ever used, add CSRF tokens + SameSite.
- Input validation at the boundary (Zod) + output encoding in web apps.
- Rate limits on auth, OTP, payment initiation, and offer-accept endpoints.
- Secrets via environment/secret manager; **never committed** (CLAUDE.md). Signing keys
  rotatable.
- OTP: hashed storage, max attempts, expiry, per-number and per-IP throttling, no user
  enumeration.
- PII minimization & encryption at rest for KYC docs (object storage with restricted access).

## 6. Data protection (Kenya DPA 2019)

- Lawful basis + consent capture at signup; privacy policy versioning.
- Data subject rights: export and deletion workflows (soft-delete + retention windows for
  financial/legal records which must be retained).
- Access to PII is role-gated and audited.

## 7. Acceptance criteria

- [ ] All protected endpoints reject missing/invalid/expired tokens (`401`).
- [ ] Role + ownership checks enforced server-side; UI-only restrictions proven insufficient
      by test (a forbidden request is rejected even when the UI hides the control).
- [ ] Refresh-token rotation + reuse-detection verified by test.
- [ ] OTP throttling and lockout verified; no user enumeration.
- [ ] Separation of duties enforced for refund/payout approval.
