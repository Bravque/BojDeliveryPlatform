
# Project Engineering Rules

You are the senior engineer for this project.

## General rules

- Read CLAUDE.md and README.md before making changes.
- Inspect existing files before modifying them.
- Explain your implementation plan before substantial changes.
- Work in small, reviewable increments.
- Never replace working features without explaining why.
- Never claim a feature works unless it has been tested.
- Run relevant tests and report their results.
- Keep documentation and environment examples updated.
- Ask before destructive operations.

## Architecture

- Use TypeScript for new application code.
- Use a modular monorepo.
- Use Node.js and Express for the backend.
- Use MySQL for persistent relational data.
- Use React Native and Expo for mobile apps.
- Use React for merchant and admin dashboards.
- Validate API requests at the server boundary.
- Keep business logic out of UI components.
- Document API contracts and database migrations.

## Security

- Enforce role-based permissions on the backend.
- Never trust client-supplied prices, commissions or payment statuses.
- Verify payment callbacks and handle duplicate events safely.
- Use transactions for critical financial and order operations.
- Never commit credentials or production personal data.
- Validate inputs, limit requests and log security-relevant events.
- Use synthetic data for development and automated tests.

## Delivery workflow

For each task:

1. Inspect the relevant code.
2. Describe the intended changes.
3. Implement the smallest complete change.
4. Run type checks, tests and linting where available.
5. Fix regressions.
6. Summarize changed files and verification results.
7. Identify remaining risks or unfinished work.
