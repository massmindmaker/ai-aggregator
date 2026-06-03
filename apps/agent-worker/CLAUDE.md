# apps/agent-worker — the live TMA money path

BullMQ runner on `:3101`. This is where credits are actually debited. Money-path
invariants live in `/SECURITY.md`; topology in `/docs/ARCHITECTURE.md`. Read both first.

## Non-obvious facts
- `src/agent-runner.ts` is the **agent runtime today**: a *stateless* BullMQ→gateway loop.
  There is no managed Hermes, no per-user process, no memory between runs. Do not write
  code that assumes a persistent runtime exists (see reality table in `/CLAUDE.md`).
- **`DEFAULT_MODEL` must exist in the gateway model registry** (`:4000`). Latent bug:
  current default `nousresearch/hermes-4-405b` is NOT registered → gateway 400 "Unknown
  model". Harmless only because there are 0 agents on prod. Fix the default OR register
  the slug before any agent relies on it.
- **Commission rule (enforced in code, do not soften):** AIAG-supplied model routed via
  `:4000` → debit balance + apply markup. User's own key / BYOK / external provider →
  charge **ZERO** (the `if (isExternal) return` short-circuit). See `/SECURITY.md`.
- **`settleRun` atomicity is load-bearing.** markCompleted + daily-spend guard + debit run
  in one `sql.begin` using guarded `UPDATE … WHERE <guard> RETURNING` (the WHERE-guard is
  what prevents double-spend / over-budget). Do NOT casually refactor it into separate
  statements or drop the guard. Covered by `__tests__/run-settle.integration.test.ts`.

## Build / run / test
- `bun run build` (tsc → `dist/`), `bun run start` (`node dist/index.js`),
  `bun run dev` (tsx watch), `bun run test` (vitest). type-check: `bun run type-check`.
- **Built MANUALLY on the VPS**, not by CI. Verify on prod; no local runtime. Deploy via
  skill `aiag-deploy`.
