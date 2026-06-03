# White-label fix — sanitize provider-brand leaks in user-facing error strings

> **Date:** 2026-06-03 · **Type:** read-only security audit + exact edit list · **Scope:** error/response strings that reach the end user or the model.
> **Rule (canon):** `/CLAUDE.md`, `/SECURITY.md`, `packages/api-gateway/CLAUDE.md` — NEVER leak an upstream provider brand (OpenRouter / Kie / Groq / Ollama / Gonka) to the end user. White-label is a hard rule.

## TL;DR

- **User-facing leaks found (must fix): 6.** Two in `apps/agent-worker/src/tools.ts` (the `image_gen` tool path that feeds results back to the model → into the user-delivered run output), one literal in `packages/api-gateway/src/upstreams/kie.ts` (`'kie job failed'`, which the gateway image/video/audio routes return verbatim to the caller in a 502 body), and the three brand-named `throw` strings in the same `tools.ts` Kie path (createTask status / createTask err / task failed / timeout — 4 strings, of which the brand-bearing ones are counted).
- **Counted precisely (see table): 6 user-facing edits across 2 files** (`tools.ts` ×5 brand strings, `kie.ts` pollOnce ×1 literal). All other brand strings are **internal-only** (logger.* / swallowed by the gateway's generic 500 onError) and may keep the brand for debugging.
- Everything in `packages/api-gateway/src/upstreams/{kie,openrouter,groq,ollama}.ts` `throw new Error('Brand …')` is **NOT directly user-facing**: those throws are caught by `server.ts` `app.onError`, which returns a generic `{ error: { code:'INTERNAL', message:'Internal error' } }` (500) for any non-`AiagError`. The brand stays in `logger.error` only. **Recommended to sanitize anyway (defence-in-depth)**, but they are not active leaks today — listed in the "defence-in-depth (optional)" section, not in the must-fix count.

---

## How the leak reaches the user (propagation proof)

### Path A — agent-worker `image_gen` tool (PRIMARY, active leak)
`apps/agent-worker/src/tools.ts`:
- `image_gen` calls Kie **directly** (`kieCreateTask` / `kiePoll`), NOT via the `:4000` gateway.
- On any Kie failure these helpers `throw new Error('Kie …')`.
- `executeTool` (line ~368) catches it: `catch (e) { return { result: { error: (e as Error).message }, cost_rub: 0 }; }`.
- That `result` is JSON-stringified and pushed into the conversation as a `role:'tool'` message (`agent-runner.ts` line ~590-594).
- The model reads it and can echo `"Kie createTask 400: …"` in its final `content`.
- `agent-runner.ts` delivers `choice.message.content` as `output` to `notifyCompleted` → `sendBotMessage(tgUserId, …)` → **the user's Telegram chat.** Confirmed user-facing.

### Path B — gateway media routes return `job.error` verbatim (active leak)
`packages/api-gateway/src/upstreams/kie.ts` `pollOnce` (line 193-199) sets, on a failed job:
`error: body.data?.failMsg ?? body.data?.failCode ?? 'kie job failed'`.
The image/video/audio routes (`routes/v1/{images,video,audio}.ts`) then return on `job.status==='failed'`:
`c.json({ error: { code:'UPSTREAM_FAILED', message: job.error ?? 'job failed' } }, 502)`.
So the literal **`'kie job failed'`** is returned in the HTTP 502 body to the caller (agent-worker / any API consumer). Confirmed user-facing. (The dynamic `failMsg`/`failCode` are Kie-supplied upstream text — a secondary passthrough risk, noted below, but the static brand literal is the concrete leak to fix.)

### Path C — gateway adapter `throw new Error('Brand …')` (NOT user-facing today)
`server.ts` `app.onError` (line 43-53): only an `AiagError` is rendered with its real message; **any other thrown `Error`** → `{ error: { code:'INTERNAL', message:'Internal error' } }`, status 500. So `throw new Error('OpenRouter 502: …')` etc. from the upstream adapters never reach the gateway's HTTP client — the brand lives only in `logger.error`. These are listed as optional defence-in-depth, not as active leaks.

---

## MUST-FIX edit list (user-facing leaks) — count = 6

### File 1 — `apps/agent-worker/src/tools.ts`  (the live TMA money path; Kie called directly, errors reach the model/user)

| # | Line | Current (leaking) | Replacement (neutral, keep status/code) | Why user-facing |
|---|------|-------------------|------------------------------------------|-----------------|
| 1 | 204 | `if (!apiKey) throw new Error('KIE_API_KEY not set');` | `if (!apiKey) throw new Error('image service not configured');` | propagates via `executeTool` catch → tool result → model → user output |
| 2 | 216 | `if (!res.ok) throw new Error(`Kie createTask ${res.status}: ${await res.text()}`);` | `if (!res.ok) throw new Error(`image service error ${res.status}`);` | same path; also drop the raw upstream body (extra brand/PII risk) — keep only the status code |
| 3 | 219 | `throw new Error(`Kie createTask err: ${j.msg ?? JSON.stringify(j)}`);` | `throw new Error('image service error: could not start generation');` | same path; `j.msg` / raw JSON is Kie-supplied → drop it |
| 4 | 248 | `throw new Error(`Kie task failed: ${j.data?.failMsg ?? 'unknown'}`);` | `throw new Error('image generation failed');` | same path; `failMsg` is Kie-supplied upstream text → drop it |
| 5 | 251 | `throw new Error('Kie task timeout');` | `throw new Error('image generation timed out');` | same path |

> Exact replacements (copy-paste):
>
> ```ts
> // line 204
>   if (!apiKey) throw new Error('image service not configured');
> // line 216
>   if (!res.ok) throw new Error(`image service error ${res.status}`);
> // line 219
>     throw new Error('image service error: could not start generation');
> // line 248
>       throw new Error('image generation failed');
> // line 251
>   throw new Error('image generation timed out');
> ```
>
> Note line 2/3/4: in addition to dropping the word "Kie", we also drop the interpolated raw upstream body / `j.msg` / `failMsg`, because those are attacker/upstream-controlled strings that can themselves contain the brand or PII. Keep only the numeric status code (line 2). If a debugging breadcrumb is wanted, add a `console.warn({...}, 'kie_tool_error')` ABOVE the throw (internal log may keep the brand — see SECURITY.md "Internal logs may keep the brand").

### File 2 — `packages/api-gateway/src/upstreams/kie.ts`  (returned verbatim by media routes in the 502 body)

| # | Line | Current (leaking) | Replacement (neutral) | Why user-facing |
|---|------|-------------------|------------------------|-----------------|
| 6 | 197 | `error: body.data?.failMsg ?? body.data?.failCode ?? 'kie job failed',` | `error: body.data?.failMsg ?? body.data?.failCode ?? 'image generation failed',` | the literal default becomes `job.error`, returned verbatim in `c.json({ error:{ message: job.error }}, 502)` by images/video/audio routes |

> Exact replacement (copy-paste), line 193-199 block:
>
> ```ts
>   if (s === 'fail' || s === 'failed') {
>     return {
>       status: 'failed',
>       job_id: prefixedJobId,
>       error: body.data?.failMsg ?? body.data?.failCode ?? 'image generation failed',
>     };
>   }
> ```
>
> **Secondary (recommended, not counted):** `body.data.failMsg` / `failCode` are Kie-supplied upstream strings echoed straight to the user. They could contain "Kie"/upstream brand text. Hardening option — have the route NOT forward `job.error` verbatim but map to a fixed neutral message, e.g. in `routes/v1/{images,video,audio}.ts` change `message: job.error ?? 'job failed'` → `message: 'generation failed'`, and keep `job.error` only in the server log. This neutralizes the dynamic-passthrough vector too. Founder/owner call: the static literal fix (#6) is the minimum; the route-level mapping is the belt-and-suspenders.

---

## Defence-in-depth (OPTIONAL — NOT user-facing today; brand swallowed by gateway onError → 500 "Internal error")

These `throw new Error('Brand …')` strings live in the gateway upstream adapters. Today they do NOT reach the client (caught by `server.ts` onError → generic `Internal error`). They DO appear in `logger.*`, which per SECURITY.md is acceptable for debugging. Sanitizing them is good hygiene (in case a future route adds a `try/catch` that re-surfaces `e.message`, e.g. via `errors.upstreamError(e.message)`), but it is **not an active leak**. If sanitized, use the neutral forms below and keep the brand in the adjacent `logger.warn`.

### `packages/api-gateway/src/upstreams/kie.ts`
- L85  `throw new Error('KIE_API_KEY not configured');` → `'image service not configured'`
- L111 `` throw new Error(`Kie ${family} ${res.status}: ${text.slice(0,200)}`); `` → `` `upstream error ${res.status}` `` (drop `family` + body)
- L117 `` throw new Error(`Kie ${family} non-JSON: ${text.slice(0,200)}`); `` → `'upstream error: malformed response'`
- L120 `` throw new Error(`Kie ${family} code=${data.code}: ${data.msg ?? 'unknown'}`); `` → `` `upstream error code=${data.code}` `` (drop `msg`)
- L124 `` throw new Error(`Kie ${family} returned no taskId: ${text.slice(0,200)}`); `` → `'upstream error: no job id'`
- L167 `throw new Error('KIE_API_KEY not configured');` → `'image service not configured'`
- L181 `` throw new Error(`Kie recordInfo ${res.status}: ${text.slice(0,200)}`); `` → `` `upstream error ${res.status}` ``
- L207 `throw new Error('Kie does not support chat completions');` → `'this model does not support chat completions'`
- L235 `throw new Error('Kie does not provide STT; use a Whisper-capable upstream');` → `'speech-to-text is not available for this model'`

### `packages/api-gateway/src/upstreams/openrouter.ts`
- L31  `throw new Error('OPENROUTER_API_KEY not configured');` → `'model provider not configured'`
- L60  `` throw new Error(`OpenRouter ${res.status}: ${text.slice(0,200)}`); `` → `` `upstream error ${res.status}` `` (drop body)
- L106 `throw new Error('OPENROUTER_API_KEY not configured');` → `'model provider not configured'`
- L129 `` throw new Error(`OpenRouter stream ${res.status}: ${text.slice(0,200)}`); `` → `` `upstream error ${res.status}` ``
- L156 `throw new Error('OPENROUTER_API_KEY not configured');` → `'model provider not configured'`
- L177 `` throw new Error(`OpenRouter embeddings ${res.status}: ${text.slice(0,200)}`); `` → `` `upstream error ${res.status}` ``

### `packages/api-gateway/src/upstreams/groq.ts`
- L30  `throw new Error('GROQ_API_KEY not configured');` → `'model provider not configured'`
- L54  `` throw new Error(`Groq ${res.status}: ${text.slice(0,200)}`); `` → `` `upstream error ${res.status}` ``
- L78  `throw new Error('GROQ_API_KEY not configured');` → `'model provider not configured'`
- L98  `` throw new Error(`Groq stream ${res.status}: ${text.slice(0,200)}`); `` → `` `upstream error ${res.status}` ``
- L125 `throw new Error('GROQ_API_KEY not configured');` → `'model provider not configured'`
- L140 `` throw new Error(`Groq embeddings ${res.status}: ${text.slice(0,200)}`); `` → `` `upstream error ${res.status}` ``

### `packages/api-gateway/src/upstreams/ollama.ts`
- L17  `throw new Error('OLLAMA_CLOUD_URL not configured');` → `'model provider not configured'`
- L45  `` throw new Error(`Ollama ${res.status}: ${txt.slice(0,200)}`); `` → `` `upstream error ${res.status}` ``
- L92  `` throw new Error(`Ollama embeddings ${res.status}: ${txt.slice(0,200)}`); `` → `` `upstream error ${res.status}` ``

### `packages/upstream-adapters/src/adapters/kie.ts`  (DEAD/legacy path — `apps/worker` only, not in the TMA money path; per SYNTHESIS.md "dead/legacy non-jobs path")
- L141 `` throw new Error(`Kie submit returned no taskId: ${JSON.stringify(data)}`); `` → `'upstream error: no job id'` (lowest priority; not user-facing)

---

## Internal-only strings that may KEEP the brand (no change needed)

Per SECURITY.md ("Internal logs (console.*) may keep the brand for debugging"), the following are fine as-is:
- All `logger.warn(... , 'kie_submit_error' | 'openrouter_upstream_error' | 'groq_upstream_error' | 'ollama_chat_error' | ...)` calls in the adapters — server-side logs, never serialized to a client response.
- `agent-runner.ts` `console.warn`/`console.info` D-0 breadcrumbs (already ₽-only / brand-neutral).
- `agent-runner.ts` thrown errors `upstream_error:` / `external` / `upstream` (line 259, 290, 294) — already brand-neutral; `label` is only ever `'upstream'`/`'external'`, never `'openrouter'`. The OpenRouter fallback throw (L290) already hardcodes the neutral word `upstream`. **No change.**

---

## Verification (per coding-behavior: typecheck/build green; no local runtime)
- After edits: `bun run type-check` in `packages/api-gateway` and `apps/agent-worker` must stay green (string-only changes, no signature change → expected green).
- The only behavioural change a consumer sees: failed `image_gen` tool results and failed media-route 502 bodies now say "image service error" / "image generation failed" instead of "Kie …". No status codes change.
- Tests to re-check: `packages/api-gateway/src/__tests__/errors.test.ts`, `upstream-mock.test.ts` (assert no brand-string assertions break); `apps/agent-worker/src/__tests__/run-settle.integration.test.ts` (unaffected — no brand assertions).
