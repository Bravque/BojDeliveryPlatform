# 05 — API Specification

> Status: DRAFT for review. The authoritative contract will be an **OpenAPI 3.1 document** at
> `docs/openapi/openapi.yaml`, from which typed clients (`packages/api-client`) are generated.
> This document defines conventions and the endpoint surface; it is not a replacement for the
> OpenAPI file.

## 1. Conventions

- Base path: `/api/v1`. Versioned in the path; breaking changes bump the version.
- JSON only (`application/json`); `utf8mb4`; all money fields are **integer cents** with an
  explicit `currency`.
- Resource identifiers in URLs/bodies are **ULIDs/UUIDs**, never DB auto-increment ids.
- Timestamps are ISO-8601 UTC.
- **Validation at the boundary** with Zod; invalid requests → `422` with field errors.
- **Idempotency:** all unsafe money/order-creating endpoints require an `Idempotency-Key`
  header; the server stores and replays the first response for a given key.
- **Pagination:** cursor-based (`?limit=&cursor=`); responses include `nextCursor`.
- **Auth:** `Authorization: Bearer <access_jwt>`; see doc 06.
- **Rate limiting:** per-IP + per-user token buckets; `429` with `Retry-After`.
- **Correlation:** every request/response carries `X-Request-Id`; echoed in logs.

### Standard error envelope
```json
{
  "error": {
    "code": "ORDER_INVALID_TRANSITION",
    "message": "Human-readable summary",
    "details": [{ "field": "quantity", "issue": "must be >= 1" }],
    "requestId": "01J..."
  }
}
```

HTTP codes: `200/201` success, `202` accepted (async), `400` malformed, `401` unauth,
`403` forbidden, `404` not found, `409` conflict (state/idempotency), `422` validation,
`429` rate limited, `5xx` server.

## 2. Endpoint surface (by domain)

> Notation: 🔒 requires auth; role(s) in brackets. "me" = authenticated principal.

### Auth & identity
```
POST   /auth/otp/request            { phone }               -> 202
POST   /auth/otp/verify             { phone, code }         -> { access, refresh, user }
POST   /auth/refresh                { refresh }             -> { access, refresh }
POST   /auth/logout         🔒      { refresh }             -> 204
GET    /me                  🔒                              -> user profile + roles
PATCH  /me                  🔒      { displayName, email }  -> user
```

### Catalogue (public reads; merchant writes)
```
GET    /towns                                              -> served towns
GET    /merchants?townId=&category=&servingAddressId=      -> merchants (zone-filtered)
GET    /merchants/:id                                      -> merchant + open status
GET    /merchants/:id/catalogue                            -> categories + products
GET    /products/:id                                       -> product + options

# merchant-managed 🔒 [merchant_owner|merchant_staff, own merchant]
POST   /merchant/catalogue/categories
POST   /merchant/catalogue/products
PATCH  /merchant/catalogue/products/:id        (price edit bumps version)
PATCH  /merchant/catalogue/products/:id/availability
PUT    /merchant/catalogue/products/:id/inventory   { trackStock, quantity }
PATCH  /merchant/profile                        { isOpen, prepMinutes }
```

### Cart & checkout  🔒 [customer]
```
GET    /cart                                              -> cart with server-priced totals
PUT    /cart/items            { productId, quantity, options }  (single-merchant guard)
DELETE /cart/items/:itemId
POST   /cart/quote            { addressId }   -> authoritative price breakdown (no order)
POST   /orders                { addressId, promoCode?, idempotencyKey }
                              -> 201 order (status=draft) + payment intent
```
`POST /orders` **recomputes all prices server-side** from the catalogue, resolves the zone &
delivery fee, applies any valid promo, reserves stock, and returns the authoritative total.
The client never sends prices.

### Orders  🔒
```
GET    /orders                 [customer: own]            -> list
GET    /orders/:id             [customer own | merchant own | assigned rider | admin]
POST   /orders/:id/pay         [customer] { idempotencyKey } -> triggers STK (doc 07)
POST   /orders/:id/cancel      [customer pre-accept | admin] { reason }
# merchant actions 🔒 [merchant, own]
POST   /orders/:id/accept
POST   /orders/:id/reject      { reason }
POST   /orders/:id/preparing
POST   /orders/:id/ready
# rider actions 🔒 [rider, assigned]
POST   /orders/:id/pickup      { confirm }
POST   /orders/:id/deliver     { proof }     -> transitions to delivered
```
All transition endpoints are thin wrappers over the state machine (doc 04); they return
`409 ORDER_INVALID_TRANSITION` if the guard fails.

### Payments & webhooks
```
POST   /orders/:id/pay         🔒 [customer]   (initiate STK; idempotent)
GET    /payments/:id           🔒              -> payment status
POST   /webhooks/mpesa/stk     (public, verified)   -> Daraja STK callback (idempotent)
POST   /webhooks/mpesa/b2c     (public, verified)   -> payout result callback
# simulation (non-prod only)
POST   /dev/payments/:id/simulate   [admin, non-prod]  { result: success|fail }
```
Webhooks are **public but authenticated by payload/source verification** (doc 07), are
idempotent via `payment_event.dedupe_key`, and always return `200` quickly after persisting
the raw event (processing is async).

### Rider
```
POST   /rider/online           🔒 [rider] { lat, lng }
POST   /rider/offline          🔒 [rider]
POST   /rider/location         🔒 [rider] { lat, lng }        (throttled; Socket.IO preferred)
GET    /rider/offers           🔒 [rider]                      -> current offers
POST   /rider/offers/:id/accept 🔒 [rider]                     -> wins race or 409
POST   /rider/offers/:id/decline 🔒 [rider]
GET    /rider/earnings         🔒 [rider]
```

### Zones, pricing, promotions, admin  🔒 [admin|ops|finance]
```
GET/POST/PATCH  /admin/zones
GET/POST/PATCH  /admin/delivery-fee-rules
GET/POST/PATCH  /admin/commissions           (merchant commission_bps)
GET/POST/PATCH  /admin/promotions
POST            /admin/orders/:id/reassign    { riderId, reason }
POST            /admin/orders/:id/cancel      { reason }
POST            /admin/refunds                { orderId, amountCents, reason, idempotencyKey }
POST            /admin/refunds/:id/approve
GET             /admin/reconciliation         -> mismatches
GET/POST        /admin/settlements            (generate/approve)
GET/POST        /admin/payouts                (generate/approve)
GET             /admin/reports/...            -> GMV, volumes, utilization
GET             /admin/audit-logs
```

## 3. Real-time channels (Socket.IO)

| Namespace/room | Audience | Events (server→client) |
|----------------|----------|------------------------|
| `order:{ulid}` | customer, merchant, assigned rider, admin | `status.changed`, `rider.location`, `payment.updated` |
| `rider:{id}` | that rider | `offer.new`, `offer.expired`, `assignment.confirmed` |
| `merchant:{id}` | that merchant | `order.new`, `order.updated` |

Room membership is authorized on join with the same RBAC as REST. Real-time payloads are
**notifications**; clients re-fetch canonical state via REST for anything money/state-critical.

## 4. OpenAPI & client generation

- `docs/openapi/openapi.yaml` is the single source of truth for request/response schemas.
- Zod schemas in `packages/validation` and OpenAPI schemas are kept in sync (generated from
  Zod, or validated against each other in CI).
- `packages/api-client` is generated from OpenAPI and consumed by all frontends — **no app
  hand-writes request/response types.**

## 5. Acceptance criteria

- [ ] `openapi.yaml` validates and renders; CI fails on drift from Zod schemas.
- [ ] Every unsafe endpoint enforces `Idempotency-Key` and replays stored responses.
- [ ] Contract tests assert error envelope shape and status codes.
- [ ] No endpoint accepts a client-supplied price, commission, fee, or payment status.
