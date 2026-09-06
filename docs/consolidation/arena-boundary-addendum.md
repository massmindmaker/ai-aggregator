# Addendum: CRLF, divergence, and exact integration

## Normalized dirty-state

In `/home/bob/Projects/aiarena` the normalized product patch is **empty**:

```text
git diff --quiet --ignore-cr-at-eol -- <non-generated pathspec>
exit 0
```

Raw `git diff` is non-empty solely because the current worktree has CRLF/EOL/index noise. Therefore none of the 101 tracked `wave2` changes should be applied to a new canonical root. The only non-CRLF material at that location is the two untracked audits:

- `aiarena-app/docs/audit/business-logic-audit-2026-08-31.md` (213 lines);
- `docs/audit/full-product-review-2026-08-31.md` (200 lines).

Archive those documents and the raw dirty state for provenance; normalize/restore the old worktree only after the new root is accepted. There is no product patch to merge from it.

## Branch comparison

`wave2...wave5-release` has exactly divergent tips: `d087933` on wave2 versus two commits on wave5-release:

1. `6adac50 docs(plan): define AI Arena 48-to-108 program and Wave 5 security`;
2. `61b05fb test(safety): isolate all mutating e2e by database marker`.

`master` is an ancestor of `wave5-release`; `wave2` is not. The committed wave5 delta adds `0008_environment_marker`, DB marker APIs/guard, isolated E2E orchestrator/scenarios and release-test scripts. It is newer product infrastructure, not a patch to replay onto wave2.

## External worktree is dirty — do not copy it wholesale

`/home/bob/.hermes/worktrees/aiarena-wave5-release` has 10 modified application files, 3 new security scripts, `docs/security/credential-rotation-2026-08.md`, five untracked Wave 6–10 plans, and one Chrome cache file. Its normalized app diff is substantive (29 additions / 16 deletions): it attempts to remove hardcoded E2E/demo credentials and add tracked-secret scans.

That dirty patch currently has at least two blocking defects, so it must be reviewed/fixed in staging instead of applied mechanically:

- `aiarena-app/.tools/e2e-wave1.js` introduces `const PASS = runtimePassword()` while retaining `const PASS = "WaveOne-Member-Pass!"` in the same scope: syntax error.
- `aiarena-app/.tools/e2e-t8.js` contains a literal `\\n` between two declarations, rather than a newline.

`drizzle.config.ts` also drops the placeholder DATABASE_URL and scripts now depend on the new untracked credential helper, so partial application would break tooling.

## Exact safe integration into the planned staging clone

1. Create the independent staging clone at committed `61b05fb` (`wave5-release`); retain all refs via a bundle before any exchange. This imports the reviewed Wave 5 commits without touching either existing worktree.
2. Bring in only the two `wave2` audit documents as untracked review material; do not apply its CRLF-only tracked patch. Keep `.chrome-test` and `.tools/node_modules` outside staging as forensic artifacts.
3. Treat the external dirty security changes as a separate candidate commit. Copy their files into staging only after fixing the two syntax defects and reviewing the full security-delta together: three helper scripts, ten callers/config files, `package.json`, and `docs/security/credential-rotation-2026-08.md`. Run the isolated unit/release checks there before committing. Do not import the Chrome cache.
4. Copy planning documents independently; they are not implementation: `docs/superpowers/plans/2026-08-31-aiarena-wave6-team-up.md` and `docs/superpowers/plans/2026-08-31-aiarena-wave7-workspace-evaluator.md` (plus the Wave 8–10 plans if desired). Wave 7 explicitly requires the completed Wave 6 migration tip `0011_team_up_foundation`; current committed staging ends at `0008`, so evaluator work cannot begin yet.

This order preserves history and all meaningful material while preventing an old wave2 working patch from regressing Wave 5 isolation or overwriting newer database/E2E foundations.
