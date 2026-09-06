# AI Aggregator security contract

## Authentication and secrets

- Web handlers use `getAuthenticatedUser()` and authorize with `authUser.user.id`.
- Gateway keys authenticate organization requests and are never logged in full.
- Secrets live outside Git and are never copied from production into tests or build logs.
- BYOK credentials remain encrypted at rest and UI surfaces show only a non-sensitive suffix.

## SQL and money integrity

- SQL uses prepared statements.
- Payment and credit transitions use guarded atomic updates with `RETURNING` inside the intended transaction.
- Duplicate callbacks must be idempotent.
- Gateway usage debits the organization credit ledger defined by the database migration contract.
- Refund credit reversal and provider-agnostic settlement remain explicit P0 gaps; do not infer completion from the current Tinkoff credit-bridge tests.

## Network and UI

- Customer errors do not expose upstream brands, raw provider payloads or secrets.
- Outbound provider URLs pass the existing SSRF validation and egress path.
- `apps/web/src/middleware.ts` owns browser security headers, including CSP.

Agents Market JWT, TON and membership rules belong to `/home/bob/Projects/agents-market`. Arena evaluation sandbox rules belong to `/home/bob/Projects/aiarena`.
