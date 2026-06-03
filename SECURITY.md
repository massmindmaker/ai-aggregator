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

## White-label
- Error labels and UI never reveal upstream brand (OpenRouter/Kie). aiag path routes via `:4000`; OpenRouter only as documented degraded fallback.

## Known SECURITY-TODOs (tracked, not yet fixed)
- provider_id SSRF re-validation (R1-7); eval-runner nsjail sandbox; VPS root password; live-revocation (jwt-denylist isRevoked stub).

## Never expose
- Personal Telegram (@b0brov / channels) in any artifact. Use neutral placeholders (@username).

## Local environment note
- This repo runs on native Windows 10: Claude Code's OS-level Bash sandbox does NOT apply (macOS/Linux/WSL2 only). Protection here is the permission system. For real isolation use WSL2 + `/sandbox`.
