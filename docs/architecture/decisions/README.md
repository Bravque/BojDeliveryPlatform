# Decision Records

This directory is the authoritative log of decisions that shape the platform.

- **[decision-log.md](decision-log.md)** — chronological log of accepted decisions, including
  the business/operational decisions handed down in the 2026-10-17 architecture review
  (D1–D12) and the engineering constraints attached to that approval.
- **ADRs** (`NNNN-title.md`) — longer-form Architecture Decision Records for decisions that
  required analysis and a recommendation. Format: Context → Options → Decision → Consequences.

Index of ADRs:

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-data-access-knex-over-prisma.md) | Data access: Knex over Prisma | Accepted |

When a decision changes an assumption in `../01`…`../12`, update the affected document and
reference the decision here (smallest necessary change).
