# packages/database — Drizzle schema + SQL migrations

Single Postgres `aiag`, shared by both products. Schema (Drizzle) + raw `.sql` files in
`migrations/`. Money/concurrency rules: `/SECURITY.md`. Stores map: `/docs/ARCHITECTURE.md`.

## Non-obvious facts
- **Prod migrations are MANUAL and UNTRACKED.** There is no applied-migrations table on
  prod; the `migrations/` files are hand-run in order. Before adding one, check what's
  already live on the VPS — don't assume sequence numbers match prod state.
- **The app DB user `aiag` cannot run `ALTER`.** DDL on prod must go through
  `sudo -u postgres psql aiag`. Plan schema changes accordingly; the app role only does
  DML. Deploy/migration recipe = skill `aiag-deploy`.
- **Atomic money pattern is mandatory**: `UPDATE … WHERE <guard> RETURNING` (per-row lock +
  WHERE-guard = double-spend/over-budget safe), READ COMMITTED, no SERIALIZABLE retry loop.
  Full rationale in `/SECURITY.md`. New balance-touching schema/queries must support it.
- ⚠️ `tg_user_balances` currently stores ₽ but is **migrating to a crypto-credit unit**
  (TMA went crypto-only). Treat its unit as in-flux; coordinate with TMA money code.

## Commands (`drizzle-kit`)
- `bun run db:generate` (gen SQL from schema), `db:push`, `db:migrate`, `db:studio`.
- `bun run build` (tsup → `dist/`, both `.` and `./schema` exports). type-check: `type-check`.
- `bun run gen:catalog` regenerates the static marketplace catalog from a prod dump.
- NOTE: `db:push`/`db:migrate` are for local/dev only — **do not point them at prod**
  (use the manual `sudo -u postgres psql` path above).
