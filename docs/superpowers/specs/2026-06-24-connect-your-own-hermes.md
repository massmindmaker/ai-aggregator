# Connect-Your-Own-Hermes — integration spec (TMA "Agents Market")

> Research date: 2026-06-24. Hermes version context: **v0.17.0 "Reach" (tag `v2026.6.19`, 2026-06-19)**; founder's box runs `main` (newer). Everything below is verified against official docs + GitHub `main`; where docs lag the code, it is flagged as a **SPIKE**.
> Product flow to support: *a user who has their OWN Hermes connects it to our external app; through that Hermes they create separate profiles/sub-agents, use them, and publish them on our marketplace.*

Primary sources (cite-checked):
- Repo: https://github.com/NousResearch/hermes-agent (README, v0.17.0)
- Releases: https://github.com/NousResearch/hermes-agent/releases (tag https://github.com/NousResearch/hermes-agent/releases/tag/v2026.6.19)
- API Server: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server (mirror: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md)
- Web Dashboard / management API: https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard
- Profiles: https://hermes-agent.nousresearch.com/docs/user-guide/profiles
- Profile commands: https://hermes-agent.nousresearch.com/docs/reference/profile-commands/
- Profile Distributions ("share a whole agent"): https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions
- Multi-profile gateways: https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways
- Open WebUI integration: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/open-webui
- Memory isolation issues: #4726 (https://github.com/NousResearch/hermes-agent/issues/4726), #34352 (https://github.com/NousResearch/hermes-agent/issues/34352), #10376 (https://github.com/NousResearch/hermes-agent/issues/10376), #17068

---

## (a) Verified facts — answers to the 5 questions

### Q1. Connect a user's own Hermes to an EXTERNAL third-party app + safe auth

**The v0.16/v0.17 "remote gateway over OAuth" is NOT for external apps driving a gateway.** It is a *client-to-remote-gateway* feature: the Hermes **desktop app** points at a remote Hermes gateway (homelab / hosted box / teammate's server) over a secure WebSocket and authenticates with **OAuth or username/password**. Direction = a Hermes-aware client connects to a Hermes backend; it is not a third-party-app authorization grant.
- Source: v0.16 "Surface Release" notes — *"Point it at a remote Hermes gateway … connects over a secure WebSocket, authenticating with OAuth or a username/password login"* (https://github.com/NousResearch/hermes-agent/releases). iMessage/Photon Spectrum uses **device-code OAuth** (`hermes photon login`) — that is a Hermes→provider login, also not a third-party grant.

**Can our server (external control-plane) drive a user's Hermes?** Yes — over the **REST API server** on `:8642` (`API_SERVER_PORT` default `8642`, `API_SERVER_HOST` default `127.0.0.1`, `API_SERVER_ENABLED` default `false`). Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server.

**Safe auth = static Bearer `API_SERVER_KEY`.** Auth is a single static bearer token passed as `Authorization: Bearer <API_SERVER_KEY>`; docs state it is **required for every deployment**. There is **NO documented OAuth/device-code/scoped-token mechanism for the REST API server**, and **no documented way to grant a third party scoped access without handing over that key.** The `/api/*` *dashboard* management endpoints can sit behind a richer auth gate (Nous OAuth / username-password / self-hosted OIDC) **when bound to non-loopback without `--insecure`**, but that gate issues **session cookies for a human in a browser**, not a scoped machine token for an external service. So for machine-to-machine, the only documented credential is the master `API_SERVER_KEY`.
- Implication: connecting a user's Hermes to us = the user gives us their `API_SERVER_KEY` + reachable URL. That key is effectively a master key for that gateway. **No native key-scoping / least-privilege.** (See gaps.)

### Q2. Profiles vs sub-agents — concepts + creation

**Profile** = a separate Hermes home directory (`HERMES_HOME=~/.hermes/profiles/<name>`) with its **own** `config.yaml`, `.env`, `SOUL.md`, memories, sessions, cron jobs, skills, and `state.db`. "119+ files resolve paths via `get_hermes_home()`." This is the unit that maps to "an agent." Source: https://hermes-agent.nousresearch.com/docs/user-guide/profiles.

**Sub-agent / delegate** = transient parallel workstream — README: *"Spawn isolated subagents for parallel workstreams."* These are runtime delegations within a session, not a persistable/publishable artifact. Raft is a *messaging platform plugin* (external agent wake-channel), not a sub-agent unit.

**The unit a user "creates and publishes" is a PROFILE**, not a sub-agent.

**Profile creation — CLI (https://hermes-agent.nousresearch.com/docs/reference/profile-commands/):**
```
hermes profile create <name> [flags]
  --clone                 # copy config.yaml, .env, SOUL.md, skills (from current profile)
  --clone-all             # copy config, memories, skills, cron, plugins;
                          #   EXCLUDES sessions, state.db, backups, state-snapshots, checkpoints
  --clone-from <profile>  # source a specific profile instead of current; implies --clone
  --no-alias              # skip ~/.local/bin/<name> wrapper
  --no-skills             # empty profile, zero bundled skills
  --description "<text>"  # routing description for the orchestrator
```
Full subcommand set: `list, use, create, describe, delete, show, alias, rename, export, import, install, update, info`.

**Can profiles be created/managed over REST? NO.** Profile CRUD is **CLI/filesystem only.** There is **no `/api/profiles` or `/v1/profiles` REST endpoint** (confirms the live-box finding: `/v1/profiles` = 404). The dashboard has a `/profiles` **UI page**, but it is not exposed as a machine REST surface. The management families (`/api/config`, `/api/env`, `/api/skills`, `/api/tools/toolsets`, `/api/mcp`, `/api/model/{info,options,auxiliary,set}`) accept `?profile=<name>` (or `"profile"` in the JSON body) to **scope reads/writes to an existing profile's `HERMES_HOME`**, but they **cannot create a profile** — unknown profile name → `404`. Sources: https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard, https://hermes-agent.nousresearch.com/docs/reference/profile-commands/.
- `admin_config_rw:false` (seen on the live box) is consistent: the management write path is gated/off; with it off you get read-only `/api/*` and can't even mutate an existing profile's config remotely.

### Q3. Multiplex + addressing a specific profile via REST

**v0.17 multiplex = `gateway.multiplex_profiles: true`** (set on the **default profile only**; also accepted top-level `multiplex_profiles: true`). On restart the default gateway enumerates every profile and brings up each profile's enabled **messaging platforms** under that profile's own credentials, routing each inbound message to its owning profile. (#48273 "Multiplex all profiles over one gateway process (opt-in)".) Sources: https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways, https://github.com/NousResearch/hermes-agent/releases/tag/v2026.6.19.

**CRITICAL: multiplex is for MESSAGING PLATFORMS, not the REST `/v1` API.** The docs explicitly scope it to inbound platform messages. Port-binding platforms — including **`api_server`** — must be configured **only on the default profile** under multiplex. There is **NO documented way for a `/v1/chat/completions` caller to select a profile** via the `model` field, a header, or a path when multiplexed. HTTP **webhook** inbound *does* get URL routing (`POST http://host:8644/p/<profile>/webhooks/<route>`), but that prefix pattern is **webhooks only, not `/v1/*`.** Source: https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways.

**Therefore, to address a specific profile over REST today you run one API server per profile on its own port.** Each profile's API server advertises its profile name as the model ID; `/v1/models` lists only that bound profile (defaults to profile name, or `hermes-agent` for default). The **`model` field in `/v1/chat/completions` is cosmetic** — it does NOT select the backend model or the profile; the model is server-side `config.yaml`. Per-profile pattern: `hermes -p alice gateway &` / `hermes -p bob gateway &` on different `API_SERVER_PORT`s. Sources: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server, https://hermes-agent.nousresearch.com/docs/user-guide/messaging/open-webui.

**Isolation headers:** `X-Hermes-Session-Key` = stable per-channel id for long-term memory (≤256 chars), independent of the transcript-scoped `X-Hermes-Session-Id` (rotates on `/new`); advertised in `/v1/capabilities` as `"session_key_header": "X-Hermes-Session-Key"`. Source: api-server doc.

**Memory isolation (bug #4726) is NOT safely fixed.** The holographic memory provider uses a single shared `~/.hermes/memory_store.db`; all profiles read/write the same fact pool with no source attribution (#4726). #10376: *"--clone copies memory, and agents can read across profile boundaries"* — profile isolation is **incomplete**. #34352 (multi-tenant): memory ops **bypass the hook system**, *"making tenant isolation impossible without forking core"*, and *"two bots on the same instance produce identical session keys … causing session state bleed"* (#17068). A `context_id`-scoped fix + a `memory:scope` hook are **proposed/partial, not a merged guaranteed boundary.** Conclusion unchanged from prior MEMORY.md: **Hermes memory is not a safe per-hirer boundary out of the box — our DB must be the source of record.** Sources: issues #4726, #10376, #34352, #17068.

### Q4. Export / share a profile spec for "publish to marketplace"

**Hermes has a first-class "share a whole agent" mechanic: Profile Distributions** (git-based). This maps almost exactly to our "publish template (spec only, no keys)". Source: https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions.

A distribution is a git repo containing:
- `distribution.yaml` (manifest: `name` required; `version`, `description`, `hermes_requires`, `author`, `env_requires[]`)
- `SOUL.md` (persona), `config.yaml` (model/temperature/tool defaults)
- `skills/`, `cron/`, `mcp.json` (MCP server connections)

**Hard-excluded (never shipped, even if author accidentally commits them):** `auth.json` (OAuth tokens), `.env` (API keys/secrets), `memories/`, `sessions/`, `state.db*`, `logs/`, `*_cache/`, `local/`.

Lifecycle:
- Author publishes by pushing the repo (zero build step). Install: `hermes profile install github.com/you/research-bot --alias`. Update: `hermes profile update <name>`. Info: `hermes profile info <name>`.
- On install: clone → read manifest → check `env_requires` against the user's shell → copy distribution-owned files to `~/.hermes/profiles/<name>/` → **strip hard-excluded paths** → generate `.env.EXAMPLE` with required keys commented → optional alias. Recipient supplies their own keys.

There is **no `hermes profile publish` / `pack` subcommand** — "publish" = push the git repo. There is also a separate `hermes profile export`/`import` (tar.gz) for full backup/restore (this one is NOT spec-only — it's a whole-profile archive).

So Hermes natively gives us: **spec-only sharing with secret/memory/history stripping = Profile Distributions (git).** Our "templates = public spec, private keys/memory" mechanic is directly supported in shape.

### Q5. Run a connected agent + get a run-trace + billing data

Endpoints (all `Authorization: Bearer API_SERVER_KEY`; source: api-server doc):
- **`POST /v1/runs`** → returns `run_id`; accepts `input` + optional `session_id`, `instructions`, `conversation_history`, `previous_response_id`.
- **`GET /v1/runs/{run_id}/events`** → **SSE** stream: `tool.started`, `tool.completed`, `assistant.delta`, `run.completed` — **this is the run-trace surface (tool-call visibility).**
- **`GET /v1/runs/{run_id}`** → poll state (`completed|failed|cancelled`), output, **`usage` tokens** (for dashboards without persistent SSE).
- **`POST /v1/runs/{run_id}/stop`** and **`POST /v1/runs/{run_id}/approval`** (resolve gated tool calls).
- **`POST /v1/chat/completions`** → OpenAI-compatible; `stream:true` SSE emits `chat.completion.chunk` + custom **`hermes.tool.progress`** events (tool-start visibility without polluting persisted text).
- **`POST /v1/responses`** → OpenAI Responses API; SSE emits spec-native `function_call` / `function_call_output` / `message` output items + `response.*` events; server-side storage with `previous_response_id` / `conversation` chaining (max 100 stored, LRU, SQLite).

**Best for a run-trace UI:** `/v1/runs` + `/v1/runs/{id}/events` (cleanest lifecycle + tool events + stop/approval). `/v1/responses` is a good alternative when you want server-side conversation persistence and spec-native function-call items.

**Billing data:** responses include `usage` = `{prompt_tokens, completion_tokens, total_tokens}` on `/v1/chat/completions`, `/v1/responses`, and `/v1/runs/{run_id}`. **NO cost/pricing field is returned** — token counts only. We must price tokens ourselves. (And note: if the connected Hermes uses the *user's own* provider keys, that is BYOK = **zero AIAG commission** per our commission rule.)

---

## (b) Recommended integration design for TMA (mapped onto native Hermes)

### Connect flow ("connect your own Hermes")
1. User enables the API server on their box: `API_SERVER_ENABLED=true`, sets a strong `API_SERVER_KEY`, exposes `:8642` (reverse-proxy + TLS). For multi-profile addressing they run **one API server per profile on distinct ports** (see Q3) — capture a `{profileName, baseUrl, port}` list.
2. TMA "Connect Hermes" form collects: **base URL** (e.g. `https://user-box:8642/v1`) + **`API_SERVER_KEY`**. Store encrypted (AES-256-GCM, same as BYOK; show last-4 only — per SECURITY.md).
3. Validate: `GET /v1/health` (no auth) for reachability, then `GET /v1/models` + `GET /v1/capabilities` (Bearer) to confirm auth and read `session_key_header`. Record the advertised model/profile name.
4. Mark this connection **BYOK / external** (`isExternal=true`) → **zero AIAG commission** on its runs (commission rule).
5. **Honest UI:** label it "Подключённый Hermes (свой ключ · 0% комиссии)". Do NOT promise managed provisioning.

### Create-profile / sub-agent flow
- **Reality:** profile creation is **CLI/filesystem only — not REST.** We cannot create a profile purely via `:8642`.
- Two honest options:
  - **(A) Per-port pre-provisioned profiles:** the user creates profiles themselves (`hermes profile create <name> --clone-from <base>`) and registers each `{name, baseUrl}` in TMA. TMA drives each over REST. Simplest honest path.
  - **(B) Control-plane scripting (our managed boxes only):** on infra WE control, we script provisioning (`mkdir ~/.hermes/profiles/<name>` + cp config + `hermes profile create --clone-from`), exactly as canon §5 / ARCHITECTURE "Hermes-proxy layer" already says. NOT usable against a *user's own* box (we don't have shell there).
- After a profile exists, **editing its spec** over REST is limited to the `/api/*` management families with `?profile=<name>` — and only **if `admin_config_rw` is enabled** on that box. Treat remote profile-config editing as **best-effort / opt-in**, never assume it.

### Publish flow ("publish to marketplace")
- Map our "publish template (spec only, no keys)" onto **Hermes Profile Distributions** in shape:
  - We collect the publishable spec = `SOUL.md` + `config.yaml` (model/tooling defaults) + `skills/` + `cron/` + `mcp.json` + a `distribution.yaml` manifest with `env_requires[]`.
  - We **enforce the hard-exclude list** ourselves (`.env`, `auth.json`, `memories/`, `sessions/`, `state.db*`, `logs/`, `*_cache/`, `local/`) — never store these in a published template. This matches Hermes' own guarantee and our `agent_templates` "0 secret columns" rule.
  - **Decision point:** either (i) mirror Hermes' git-distribution model (template = a git repo URL others `hermes profile install`), or (ii) keep templates in our DB and emit a Hermes-compatible distribution bundle on clone. (ii) fits the existing TMA marketplace/clone-flag better and keeps us the catalog. Recommend (ii); reuse Hermes' manifest schema so a bundle is also `hermes profile install`-able.
- Clone-from-template (already LIVE in TMA) ≈ Hermes `--clone-from` / `profile install`: copies spec, requires the cloner to supply their own keys (`.env.EXAMPLE`).

### Run + bill flow
- Submit: `POST {baseUrl}/v1/runs` with the user's input (+ `session_id` per our run, + `X-Hermes-Session-Key` set **server-side by the worker** from `(agent_id, hirer)` — never from the request body, per SECURITY.md memory-isolation rule).
- Trace UI: subscribe `GET /v1/runs/{id}/events` (SSE) → render the run-trace timeline (DESIGN.md run-trace component): map `tool.started`/`tool.completed`/`assistant.delta`/`run.completed` to step cards. Fallback poll `GET /v1/runs/{id}`.
- Bill: read `usage.total_tokens` from `/v1/runs/{id}` → price in **our** ledger (D-0/D-1 USD-credit). If the connection is BYOK/external → **debit 0** (commission rule). Hermes returns **no cost**, only tokens — pricing stays ours.
- Memory: **our Postgres is the source of record** for per-hirer history/memory (Hermes shared `memory_store.db` is not a safe boundary — Q3). Scope every run with our `(agent_id, hirer_tg_user_id)` namespace server-side.

---

## (c) Explicit GAPS / unknowns / SPIKE items

1. **No scoped third-party token for `:8642`.** Only a static master `API_SERVER_KEY`. Connecting a user's Hermes means holding their master key — no least-privilege, no per-app revocation beyond key rotation. **SPIKE:** confirm on the live `main` box whether any newer scoped-token/OAuth-for-REST exists; if not, design around master-key custody (encrypt, rotate, scope our usage).
2. **Profiles cannot be created over REST** (CLI/filesystem only; `/v1/profiles`=404 confirmed). Remote create requires shell access → only works on infra we control, not a user's own box. **Design must not assume remote profile creation.**
3. **Multiplex does NOT give REST profile-selection.** `gateway.multiplex_profiles` routes *messaging platforms*, and `api_server` must live on the default profile only. **To address N profiles over `/v1` you need N API servers on N ports.** **SPIKE:** verify on `main` whether any undocumented header/`model`-field profile routing for `/v1/chat/completions` exists (docs say no; the live box `model` field was cosmetic).
4. **Memory isolation is not a safe boundary** (#4726/#10376/#34352/#17068): shared `memory_store.db`, cross-profile reads, session-key bleed between bots on one instance. The `context_id`/`memory:scope` fixes are proposed/partial. **We must enforce isolation in our DB; do not rely on Hermes per-profile memory for multi-hirer.** **SPIKE:** check `main` for merged `context_id` memory scoping and whether `--clone` still copies memory.
5. **`admin_config_rw` / remote config editing is opt-in and may be off** (was `false` on the live box). Remote spec editing via `/api/*?profile=` is best-effort; can't be a hard dependency.
6. **No cost field in `usage`** — tokens only. Pricing is entirely ours (fine, but means we need a token→credit table per model the user's Hermes uses; if they use exotic models we may not have a price). **SPIKE:** enumerate which models the connected Hermes can report and how we price unknown ones.
7. **Distribution = git, not API.** Hermes' native publish is "push a git repo / `hermes profile install <url>`". Our marketplace is DB-backed; reconcile by emitting Hermes-compatible bundles (manifest schema reuse) — needs a builder. Not a blocker, but unbuilt.
8. **Docs lag `main`.** v0.17 multiplex landed (#48273) but `api-server.md`/`web-dashboard` on `main` don't yet describe REST behavior under multiplex. Treat any multiplex-REST assumption as unverified until checked on the founder's `main` box.
