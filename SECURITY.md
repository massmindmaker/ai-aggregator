# SECURITY.md — AIAG

Load-bearing: the TMA money path is live on prod. These are the security rules code must uphold.

## Auth
- Gateway: `AIAG_GATEWAY_KEY` (`sk_aiag_live_…`) authenticates agent-worker → gateway `:4000`.
- TMA JWT: HS256-pinned (`{algorithms:['HS256'], iss:'aiag-tma', aud:'aiag-gateway'}`); fail-hard if `TMA_JWT_SECRET` unset/<32 chars.
- nginx strips `x-middleware-subrequest` + `x-tma-user-id` on `/tg` (CVE-2025-29927 defence); Next pinned 14.2.33.

## Secrets
- All keys live in `/srv/aiag/shared/.env` on the VPS. Never commit, never echo to the user, never bake into `.next`.
- BYOK credentials: AES-256-GCM, stored as `encryptSecret(key).toString('base64')`; UI shows only last 4 chars.

## SQL & concurrency
- Prepared statements only. Atomic money ops use guarded `UPDATE … WHERE <guard> RETURNING` (per-row lock + WHERE-guard = double-spend/over-budget safe). READ COMMITTED, no SERIALIZABLE/40001 loop.

## Billing integrity
- `settleRun` = markCompleted + daily-spend guard + balance debit in one `sql.begin`.
- AIAG-supplied model → debit + markup. BYOK/own provider → **zero charge** (the `if (isExternal) return` rule).
- TON top-ups: **ton-proof is verified strictly** (R2.1-A2; the old "unverified" status is obsolete). Crediting goes through the reconciler over the verified deposit.

## Memory isolation per-hirer (OWASP LLM06) — PROJECT, load-bearing for hire (canon §11)
- Memory + history are namespaced by **`(agent_id, hirer_tg_user_id)`**: index `(agent_id, COALESCE(scope_tg_user_id,0), key)`; history filtered `tg_user_id = hirer`.
- A hirer **must not see the creator's memory or any other hirer's memory** — cross-tenant memory read = OWASP LLM06.
- The scope is **wired server-side by the worker from `runId`/session, NOT from the request body** → the LLM cannot ask for someone else's namespace. This is the isolation boundary.
- Today `memorySet/Get/List` + `loadHistory` scope only by `agent_id`; the scope dimension is the unbuilt piece (canon §4). Until built, hire stays a PROJECT.

## White-label
- Error labels and UI never reveal upstream brand (OpenRouter/Kie). aiag path routes via `:4000`; OpenRouter only as documented degraded fallback.

## Known SECURITY-TODOs (tracked, not yet fixed)
- provider_id SSRF re-validation (R1-7); eval-runner nsjail sandbox; VPS root password; live-revocation (jwt-denylist isRevoked stub).

## Never expose
- Personal Telegram (@b0brov / channels) in any artifact. Use neutral placeholders (@username).

## Local environment note
- This repo runs on native Windows 10: Claude Code's OS-level Bash sandbox does NOT apply (macOS/Linux/WSL2 only). Protection here is the permission system. For real isolation use WSL2 + `/sandbox`.
