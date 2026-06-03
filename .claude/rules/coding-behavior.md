# Coding behavior (advisory, every session)

Adapted from Karpathy's CLAUDE.md template, tuned for AIAG (live money path, no local runtime).

## Think before coding
State assumptions and the plan before non-trivial changes. Surface tradeoffs. If the request is ambiguous and the choice is founder-level (money, legal, brand, strategy), ask; otherwise pick a sensible default grounded in `/CLAUDE.md` + `/PRODUCT.md` and proceed.

## Simplicity first
Minimum code that solves the request. No speculative abstractions, config flags, or error-handling for cases that can't happen. If you wrote 200 lines and it could be 50, rewrite.

## Surgical changes
Touch only what the request needs. Every changed line traces to the ask. Flag pre-existing dead/odd code, don't silently delete or "tidy" it, especially in `apps/agent-worker` and `packages/api-gateway` (the live billing/auth path). R0 is live on prod and the branch isn't merged.

## Goal-driven, verify correctly
Define success criteria up front. Verify via **typecheck/build green + checks on the VPS after deploy** — do NOT spin up local dev/tests/Docker for AIAG (see memory `feedback_no_local_runtime`). "Done" means verified, not assumed.

## Hard "never"s
- Never downgrade `next` below 14.2.33 in tg-miniapp (CVE-2025-29927).
- Never leak an upstream provider brand (OpenRouter/Kie) to end users (white-label).
- Never expose personal Telegram (@b0brov) in any artifact.
- Never hardcode prices; never use raw SQL without prepared statements; atomic money ops = `UPDATE … WHERE … RETURNING`.

These guidelines are working if: changes are small and traceable, the money/auth path stays untouched unless that's the task, and nothing claimed "done" was unverified.
