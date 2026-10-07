# packages/database — Drizzle schema + SQL migrations

Aggregator Drizzle schema + ordered raw `.sql` files in `migrations/`. Money/concurrency
rules: `/SECURITY.md`. Stores map: `/docs/ARCHITECTURE.md`.

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
- Historical Agents Market and Arena tables remain in the ordered migration sequence.
  Do not delete or renumber applied migrations. New product-owned schema work belongs in
  `/home/bob/Projects/agents-market` or `/home/bob/Projects/aiarena`; see
  `migrations/README.md`.
- **0098 is the only migration with non-additive DDL** (DROP/ADD of the three
  `network` CHECKs to admit `tvm:-1`). Its constraint names are the PostgreSQL
  autogen `<table>_network_check`; if prod ever renamed them, adjust the manual
  apply instead of skipping the widening. The 0072-era function bodies it
  replaces are mirrored in `src/functions/ton-invoice-core.sql` (latest-wins).

## Commands (`drizzle-kit`)
- `bun run db:generate` (gen SQL from schema), `db:push`, `db:migrate`, `db:studio`.
- `bun run build` (tsup → `dist/`, both `.` and `./schema` exports). type-check: `type-check`.
- `bun run gen:catalog` regenerates the static marketplace catalog from a prod dump.
- NOTE: `db:push`/`db:migrate` are for local/dev only — **do not point them at prod**
  (use the manual `sudo -u postgres psql` path above). This is not a blanket "push is
  unsafe" rule (drizzle's own docs endorse `push` for prod schema-first workflows) — it's
  conditional on **our schema being incomplete right now**: `src/schema` is missing
  legacy `agent_sessions`, `tg_user_balances`, `balance_credits`, `scope_tg_user_id`,
  `tg_topup_tx_claims`, `tg_membership_charges`, `hermes_profile`, `daily_budget_credits`
  and more, so `db:push` could diff against live prod and **drop** legacy cross-product tables it
  doesn't know about. Once schema parity + a real `__drizzle_migrations` baseline exist,
  this restriction lifts. Until then: manual psql, one file at a time, verify with a
  `SELECT`/`\d` after (no tracking table on prod — you can't trust "already applied").
