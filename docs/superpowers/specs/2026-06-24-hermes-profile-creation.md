# Hermes profile creation by a running agent — verified mechanism (2026-06-24)

> Research scope: how a running Hermes agent (NousResearch/hermes-agent, ~v0.17 "Reach", June 2026) actually creates **profiles** and **sub-agents** when instructed in chat, and how WE can drive that remotely for a rent/marketplace of agents.
> Every claim below is cited. Where docs are silent or ambiguous, it is marked **SPIKE**.

---

## 0. The observation, explained in one line

When the owner tells his Hermes "create agent Alisa" / "create additional profiles", **Hermes is not using a special profile API — it is using its `terminal` toolset to run the ordinary `hermes profile create <name>` CLI** as a shell command on the host. There is no native "profile-management tool" and no REST `/v1/profiles` endpoint; the agent just shells out, which is why it works despite the missing REST route.

---

## 1. Verified facts (with URLs)

### 1.1 There is no native profile toolset — the agent runs the CLI via `terminal`
- Hermes' toolsets are: `web, search, terminal, file, browser, vision, image_gen, moa, skills, tts, todo, memory, session_search, cronjob, code_execution, delegation, clarify, homeassistant, messaging, spotify, discord, debugging, safe`. **None is a "profile" or "profile_create" tool.** — https://hermes-agent.nousresearch.com/docs/user-guide/features/tools
- The `terminal` tool runs **arbitrary shell commands** ("Execute commands and manipulate files"); `execute_code` runs code; `process` manages background processes. — https://hermes-agent.nousresearch.com/docs/user-guide/features/tools
- Profiles are created/managed **only** by the CLI: `hermes profile create|list|use|delete|install|update`. The profile docs "mention no separate agent or tool creating profiles. Users invoke `hermes profile create` directly via CLI." — https://hermes-agent.nousresearch.com/docs/reference/profile-commands/
- **Conclusion (high confidence):** "create agent Alisa" → the agent emits a `terminal` call running `hermes profile create alisa [...]`. The profile-command reference gives **no indication these commands are agent-restricted or human-only** — they are uniform CLI operations, so an agent with `terminal` access can run them. — https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/profile-commands.md

### 1.2 Exact profile CLI (the actual creation mechanism)
From https://hermes-agent.nousresearch.com/docs/reference/profile-commands/ and the GitHub mirror:
```
hermes profile create <name> [options]
  --clone                 # copy config.yaml, .env, SOUL.md, skills from CURRENT profile
  --clone-all             # copy everything (config, memories, skills, cron, plugins) from current
                          #   EXCLUDES per-profile history: sessions, state.db, backups, snapshots, checkpoints
  --clone-from <profile>  # use a specific profile as source instead of current (implies --clone)
  --no-skills             # empty profile, zero bundled skills
  --description "<text>"  # 1–2 sentence description used for orchestrator/routing
hermes profile list          # active marked with *
hermes profile use <name>    # set active profile
hermes profile delete <name> [--yes]
hermes profile install <git-url> [--alias]
hermes profile update <name>
```
- Disk layout: each profile = a **separate Hermes home dir** at `~/.hermes/profiles/<name>/` (default profile = `~/.hermes` itself), containing its own `config.yaml`, `.env`, `SOUL.md`, `memories/`, `sessions/`, `skills/`, `cron/`, `state.db`. — https://hermes-agent.nousresearch.com/docs/user-guide/profiles
- **No restart needed**: creating a profile also generates an immediate command alias at `~/.local/bin/<name>`. — https://hermes-agent.nousresearch.com/docs/user-guide/profiles

### 1.3 Permission/approval gates on the terminal (what guards profile creation)
- `approvals.mode` in `~/.hermes/config.yaml`: **`manual`** (default — dangerous shell commands prompt), **`smart`** (aux-LLM risk triage: low auto-approve, dangerous auto-deny, uncertain prompt), **`off`** (no prompts). `/yolo` or `--yolo` bypasses for a session. — https://hermes-agent.nousresearch.com/docs/user-guide/security
- **Container backends (Docker, Singularity, Modal, Daytona, Vercel Sandbox) SKIP dangerous-command checks entirely — the container IS the security boundary.** — https://hermes-agent.nousresearch.com/docs/user-guide/security
- Terminal backends: `local` (default), `docker`, `ssh`, `singularity`, `modal` (+ Daytona/Vercel Sandbox in security doc). Config keys: `terminal.backend`, `terminal.docker_image`, `terminal.container_persistent`, `terminal.timeout`. — https://hermes-agent.nousresearch.com/docs/user-guide/features/tools , https://hermes-agent.nousresearch.com/docs/user-guide/docker
- **Implication:** `hermes profile create` issued by the agent goes through `terminal`. On a `local` backend it hits `approvals.mode`; in a container backend it runs **unprompted** (and, critically, writes to the *container's* `~/.hermes`, not the host's — see §5).

### 1.4 Sub-agents (`delegate_task`) are TRANSIENT — not the rentable unit
- Exact tool: **`delegate_task(goal, context, toolsets, role, max_iterations)`**; batch `delegate_task(tasks=[...])`. — https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- Sub-agents are **transient, not persistent**: a child "runs inside the parent's current turn… blocks the parent until every child finishes", gets "a completely fresh conversation", "Children do not continue after the parent turn ends", and are cancelled if the parent is interrupted. **They cannot be addressed/run later and never become a profile.** — https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- v0.17 adds **background** sub-agents: `delegate_task(background=true)` "runs in the background and returns a handle immediately… the full result re-enters the conversation as a new turn the moment it finishes." Still bound to the parent session — **not a standalone addressable agent.** — https://github.com/NousResearch/hermes-agent/releases
- Roles/limits: `role="leaf"` (default, cannot delegate) vs `role="orchestrator"` (keeps `delegation`); `delegation.max_spawn_depth` (default 1), `max_concurrent_children` (default 3), `max_iterations` (default 50), `orchestrator_enabled` (global kill switch), `child_timeout_seconds`. Blocked-for-subagent toolsets: `delegation` (leaf), `clarify`, `memory`, `code_execution`, `send_message`. — https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation

### 1.5 Profiles can be PUBLISHED — git-based "Profile Distributions"
- A profile is packaged as a **git repo** with a `distribution.yaml` manifest (name, version, description, required env). Install: `hermes profile install github.com/you/agent-name [--alias]`; update: `hermes profile update <name>`. — https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions
- **Included:** `SOUL.md`, `config.yaml`, `skills/`, `cron/`, `mcp.json`. **Hard-excluded (never shipped):** `auth.json`, `.env`, `memories/`, `sessions/`, `state.db*`, `logs/`, `workspace/`, `plans/`, caches. — https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions
- **No registry/marketplace exists** — distribution is plain git URLs. The docs assume **human authors**; whether an agent can programmatically publish is **not documented (SPIKE).** — https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions

### 1.6 The API server binds ONE profile per gateway/port
- OpenAI-compatible server on **port 8642** (`API_SERVER_ENABLED`, `API_SERVER_PORT`, `API_SERVER_HOST`, `API_SERVER_KEY`). Endpoints: `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/runs`, `POST /api/jobs`, `GET /v1/models`, `GET /health`. Auth: `Authorization: Bearer <API_SERVER_KEY>`. — https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- **There is NO `/v1/profiles` endpoint.** Each API server instance serves exactly one profile: `hermes -p <profile> gateway`; a second profile must set a **distinct `API_SERVER_PORT`** in its own `.env` or it conflicts on 8642. — https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server , https://hermes-agent.nousresearch.com/docs/user-guide/profiles
- Session/isolation headers (per-hirer scoping): `X-Hermes-Session-Id` (transcript scope) and `X-Hermes-Session-Key` (stable per-channel id for long-term memory, ≤256 chars), supported on `/v1/chat/completions`, `/v1/responses`, `/v1/runs`. — https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- v0.17 dashboard adds a **"full profile builder"** (browser: pick model, skills, MCP) + a **machine-wide multi-profile view with a global switcher**, and a browser admin panel (MCP catalog, channels, credentials, webhooks, memory, OIDC login). This is a **dashboard/HTTP UI feature, not a documented public REST profile API.** — https://github.com/NousResearch/hermes-agent/releases

### 1.7 Profile vs sub-agent vs Kanban/agent-network — distinctions
| Unit | Created by | Persists? | Addressable later? | Publishable? |
|---|---|---|---|---|
| **Profile** | `hermes profile create` (CLI, via `terminal`) | **Yes** (`~/.hermes/profiles/<name>/`) | Yes — `hermes -p <name>`, own gateway/port | **Yes** (git Profile Distribution) |
| **Sub-agent** | `delegate_task(...)` | **No** (dies with parent turn; bg = handle only) | No | No |
| **Orchestrator routing** | `role="orchestrator"` + profile `--description` | Routing logic, not a new unit | Routes to existing profiles | n/a |
| **Raft agent-network** | v0.17 gateway channel | network membership | metadata-only wake payloads | n/a |
- The v0.17 "Reach" release added **Raft agent-network integration as a gateway channel** ("privacy-by-contract; wake payloads carry only metadata, never message bodies"). — https://github.com/NousResearch/hermes-agent/releases
- **Kanban orchestrator across profiles** (the `--description`-driven router) is referenced by the profile-create `--description` flag but the **delegation-patterns doc does not document a cross-profile kanban router** — only nested `role="orchestrator"` sub-agents. The "orchestrator routes between *profiles*" behavior is **under-documented (SPIKE).** — https://hermes-agent.nousresearch.com/docs/guides/delegation-patterns
- **The right "create + rent" unit is the PROFILE** (persistent, isolated, addressable via its own gateway, publishable as a distribution). Sub-agents are wrong (transient).

---

## 2. The 5 answers (precise)

1. **How a running agent creates a profile:** It calls its **`terminal`** toolset to run the CLI **`hermes profile create <name> [--clone-from <src>] [--clone-all] [--description ...]`**. There is **no native profile toolset/tool** — it's a plain shell command. Gate = `approvals.mode` (local backend) or none (container backend).
2. **Profile vs sub-agent vs kanban:** **Profile** = persistent `~/.hermes/profiles/<name>` with own config/memory/skills/gateway → **the rentable unit**. **Sub-agent** (`delegate_task`, incl. v0.17 `background=true`) = transient, dies with the parent turn, not addressable, never a profile. **Kanban/orchestrator** = routing over existing profiles (`role="orchestrator"` + `--description`); **Raft** = a v0.17 network channel — neither is a creation unit.
3. **Drive creation remotely via REST:** **Indirectly yes, directly no.** No `/v1/profiles` endpoint. But a `POST /v1/runs` (or `/v1/chat/completions`) whose instruction is "create a profile X cloned from Y" makes the agent run the CLI on that host — *if* the served profile has `terminal` enabled and approvals don't block it. The new profile is **immediately usable as its own agent** but **needs its own `hermes -p X gateway` on a distinct port** to be reachable over HTTP (creation ≠ serving).
4. **Config to enable/disable:** Allow = give the profile the **`terminal`** toolset (toolset allowlist via `--toolsets` / `hermes tools`) + `approvals.mode: off|smart` (or container backend) so the CLI runs unprompted. Disallow = drop `terminal`/`code_execution` from the toolset allowlist and/or `approvals.mode: manual`. Sub-agent control = `delegation.orchestrator_enabled`, `max_spawn_depth`, `max_concurrent_children`, per-call `toolsets`/`role`.
5. **Marketplace safety:** A self-created profile lives under that **Hermes install's `~/.hermes/profiles/`** (the host's on `local`, the **container's** on docker/Daytona). On `local`, all profiles share one filesystem/host user → **NOT multi-tenant-safe** (a profile with `terminal` can read sibling profiles' `.env`/memories). Safe multi-tenancy = **one container/Daytona workspace per tenant** (`terminal.backend: docker|daytona`, `container_persistent`), matching the canon's "Docker-per-tenant" plan.

---

## 3. How WE use it for managed agents creating sub-agents (recommended mechanism)

**The single clearest mechanism for "an agent on our infra creates a sub-agent/profile that can be published & rented":**

> Treat the **profile** (not `delegate_task`) as the unit. Drive creation by sending a **`POST /v1/runs`** instruction to a *builder* Hermes whose `terminal` toolset is enabled and runs in a **per-tenant Docker/Daytona sandbox**. The run executes `hermes profile create <id> --clone-from <template> --description "<…>"`. Our control-plane then **starts a dedicated gateway** for that profile (`hermes -p <id> gateway` on an allocated `API_SERVER_PORT`), records `(profile_id → port, owner)` in our Postgres, and points the TMA/agent-worker at `http://host:<port>/v1` with `Authorization: Bearer <that profile's API_SERVER_KEY>` and per-hirer `X-Hermes-Session-Key`. **Publish/rent = git Profile Distribution** (`distribution.yaml` + push), which already strips secrets/memory exactly matching our "share spec, not data" rule.

Why this shape:
- Profiles are the only **persistent, addressable, publishable** unit (§1.7).
- Creation via `terminal`+CLI is the **proven** path (matches the owner's observation) and needs no unbuilt REST route.
- Distribution's include/exclude list (SOUL/config/skills/mcp in; `.env`/memories/sessions/state out) is a 1:1 fit for our author-rent "publish the spec, keep keys/memory private."

**Don't** use `delegate_task` for rentable agents — it's turn-scoped and disappears.

---

## 4. Permission / sandbox design (for our managed infra)

- **Per-tenant isolation = container backend, mandatory.** Set `terminal.backend: docker` (or `daytona` for stop/resume persistence: `container_cpu/memory/disk`, `container_persistent`, `DAYTONA_API_KEY`). Never run tenant agents on `local` backend on a shared host — sibling profiles share the host FS and a `terminal`-capable tenant can exfiltrate other tenants' `.env`/memory. (Matches MEMORY: Hermes memory is NOT cross-profile-safe out of the box — bug #4726 shared `memory_store.db`; our DB stays source-of-record.)
- **Builder vs runtime split.** A privileged **builder** profile (terminal on, `approvals.mode: off`, in its own sandbox) does the `hermes profile create`. **Tenant runtime** profiles should typically have `terminal` **removed** from their toolset allowlist unless the rented agent genuinely needs shell — otherwise a rented agent could create rogue profiles or read host state.
- **Approvals:** builder = `off` (unattended); any local-backend admin agent = `manual`/`smart`. In containers, dangerous-command checks are skipped by design — the container is the boundary, so container scoping must be tight (read-only FS, dropped caps per security doc).
- **Toolset allowlisting is the real control knob:** presence/absence of `terminal` + `code_execution` decides whether an agent can self-create profiles. Gate this in the profile's `config.yaml` toolsets, set by our control-plane, **never** by the model/request.
- **Delegation guardrails:** keep `delegation.max_spawn_depth: 1` and `max_concurrent_children` low for tenant agents to bound fan-out cost; `orchestrator_enabled: false` on tenants unless needed.

---

## 5. Gaps / SPIKE items (be honest)

1. **SPIKE — where a tool-created profile lands under our gateway.** A `/v1/runs`-driven `hermes profile create` creates the profile in **that gateway's Hermes home**. On `local` = host `~/.hermes/profiles/`; in a container = the **container's** `~/.hermes` (ephemeral unless `container_persistent`). Verify on the box: does our resident gateway see the new dir, and does it survive container recycle? (Canon §5 already flags multiplexing/resident-memory as spike.)
2. **SPIKE — auto-serving a newly created profile.** Creation does **not** start a gateway/bind a port for it (only an `~/.local/bin/<name>` alias). Our control-plane must script `hermes -p <id> gateway` + port allocation. Confirm no 8642 conflict and that `API_SERVER_KEY` can be per-profile.
3. **SPIKE — can the *agent itself* publish a distribution?** Docs assume human authors. Test whether a `terminal` run can do `git init/commit/push` + write `distribution.yaml` to publish a profile programmatically (likely yes via shell, but undocumented).
4. **SPIKE — cross-profile kanban/orchestrator routing.** The `--description` flag implies a router that dispatches to existing profiles, but the delegation-patterns doc only covers nested sub-agents. Confirm whether a real cross-profile router exists in v0.17 or if "routing" is just sub-agent orchestration.
5. **SPIKE — v0.17 dashboard "profile builder" HTTP surface.** The browser profile-builder/admin panel may expose internal HTTP routes we could reuse instead of shelling the CLI. Not a documented public REST API — inspect on the box before depending on it.
6. **Version note:** owner's box is on Hermes v0.12 (per MEMORY) → some flags (`--description`, `delegate_task(background=true)`, Daytona/Vercel sandbox, Raft) are **v0.16–0.17**. Upgrade the box to ~v0.17 before relying on them.

---

### Sources
- Profiles: https://hermes-agent.nousresearch.com/docs/user-guide/profiles
- Profile commands ref: https://hermes-agent.nousresearch.com/docs/reference/profile-commands/ · GitHub mirror: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/profile-commands.md
- Profile distributions: https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions
- Tools & toolsets: https://hermes-agent.nousresearch.com/docs/user-guide/features/tools
- Delegation: https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation · patterns: https://hermes-agent.nousresearch.com/docs/guides/delegation-patterns
- API server: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- Security/approvals/sandbox: https://hermes-agent.nousresearch.com/docs/user-guide/security
- Docker backend: https://hermes-agent.nousresearch.com/docs/user-guide/docker
- v0.17 "Reach" releases: https://github.com/NousResearch/hermes-agent/releases
