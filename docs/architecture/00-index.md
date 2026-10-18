# BojDeliveryPlatform — Architecture Documentation

> Status: **DRAFT — awaiting review.** No application code should be written until this
> plan is reviewed and approved. See `12-open-decisions-and-risks.md` for the business
> decisions that must be resolved before (or during) each phase.

A production-oriented, multi-category delivery platform for the Kenyan market, inspired by
Uber Eats and Glovo. Initial launch is scoped to **one town, one merchant per order,
independent riders, and M-Pesa as the primary payment method**, with simulated payments
until production Daraja credentials are configured.

## Reading order

| # | Document | Purpose |
|---|----------|---------|
| 01 | [Product Requirements](01-product-requirements.md) | Scope, personas, functional & non-functional requirements |
| 02 | [System Architecture & Monorepo](02-system-architecture.md) | Component map, monorepo layout, tech choices, boundaries |
| 03 | [Data Model (ERD + MySQL schema)](03-data-model.md) | Entities, relationships, DDL, concurrency & money rules |
| 04 | [Order State Machine](04-order-state-machine.md) | States, transitions, guards, invariants |
| 05 | [API Specification](05-api-specification.md) | REST contract, conventions, OpenAPI approach |
| 06 | [Authentication & Authorization](06-auth-and-authorization.md) | Identity, tokens, RBAC, resource ownership |
| 07 | [Payments & Reconciliation](07-payments-and-reconciliation.md) | M-Pesa/Daraja flow, idempotency, timeouts, refunds, ledger |
| 08 | [Rider Assignment & Delivery Pricing](08-rider-assignment-and-pricing.md) | Assignment algorithm, conflict handling, fee model |
| 09 | [Testing Strategy](09-testing-strategy.md) | Test pyramid, critical-path tests, environments |
| 10 | [Deployment & Disaster Recovery](10-deployment-and-dr.md) | Environments, CI/CD, backups, restore drills |
| 11 | [Delivery Phases & Acceptance Criteria](11-delivery-phases-and-acceptance.md) | Phase breakdown with explicit acceptance criteria |
| 12 | [Open Decisions & Risks](12-open-decisions-and-risks.md) | Unresolved business decisions, challenged assumptions |

## Guiding principles (derived from CLAUDE.md)

- **The server is the source of truth.** Prices, commissions, delivery fees, and payment
  status are never trusted from the client; they are computed and verified server-side.
- **Money is handled with integer minor units and double-entry ledger discipline.** No
  floating-point currency math.
- **Every state-changing financial operation is idempotent and transactional.**
- **Role-based authorization is enforced at the backend boundary**, not in the UI.
- **Build in small, reviewable increments.** Each phase has explicit acceptance criteria.
- **Nothing is claimed "working" until it is tested** with reported results.

## What this plan deliberately defers

Multi-town routing, multi-merchant baskets, fleet/employed riders, in-app wallets,
card payments, and ML-based demand forecasting are explicitly **out of initial scope** but
the data model and service boundaries are designed so they can be added without a rewrite.
See each document's "Future-proofing" notes.
