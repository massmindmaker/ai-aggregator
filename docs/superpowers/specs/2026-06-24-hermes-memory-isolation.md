# Hermes memory + per-tenant isolation — verified research (2026-06-24)

> Scope: how Hermes (NousResearch/hermes-agent, current `main` + v0.17 "Reach", tag `v2026.6.19`, 2026-06-19) handles memory, what "Memorius" is, whether built-in memory is a safe multi-tenant boundary, and the right design to give each **agent** and each **hirer** isolated memory in our marketplace.
> Method: grounded in Hermes docs (`hermes-agent.nousresearch.com/docs`, the `website/docs/**` source in the repo), provider docs, and GitHub issues #4726 / #10376 / #34352 / #20060 / #20199. Every load-bearing claim has a URL. Unclear items are marked **SPIKE**.

---

## TL;DR for the build

- Hermes has **built-in memory** (`MEMORY.md`, `USER.md` in `~/.hermes/memories/`, the `memory` tool, sessions in `~/.hermes/state.db` FTS5 + `session_search`) **plus 9 pluggable external providers**, only **one external active at a time**, built-in always on.
- **"Memorius" is NOT a Hermes provider.** The closest real things are **Memori** (newest official provider, `hermes-memori`) and **mem0** (the mainstream namespaced one). Treat "Memorius" as the owner loosely meaning one of these — most likely **mem0**.
- **Built-in memory is NOT a safe tenant boundary today.** Confirmed open bugs: shared `memory_store.db` (#4726, OPEN), `--clone` copies + cross-profile file reads (#10376, OPEN), and **session-key collision / global memory across users on one process** (#34352, OPEN). The agent's own file tools can read other profiles' files — isolation is path-convention, not enforced.
- **Recommendation:** our **own Postgres is the memory of record**, scoped by `(agent_id, hirer_tg_user_id)` and injected into context server-side; Hermes built-in/provider memory is treated as **disposable cache**, never the trust boundary. Hard tenant separation = **one Hermes profile/process per (agent) and a stable per-hirer `gateway_session_key`** via `X-Hermes-Session-Key` (shipped in v0.17, PR #20199) — but **do not rely on it alone** because the storage layer still doesn't enforce scope.

---

## 1. What memory systems Hermes supports

### (a) Built-in
- Memory files live in `~/.hermes/memories/`: **`MEMORY.md`** (agent's own notes, ~2.2k chars) and **`USER.md`** (user profile, ~1.4k chars). Both are **injected into the system prompt as a frozen snapshot at session start** — not live-updated mid-session.
  - Source: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md>, <https://hermes-agent.nousresearch.com/docs/user-guide/features/memory>
- **`SOUL.md` is NOT a memory file — it is the agent's persona/config** (persists across `--clone`, copied manually). It belongs with `config.yaml`/`.env`, not in the per-session memory store.
  - Source: #10376 mitigation note "manually copy only `config.yaml`, `.env`, and `SOUL.md`" — <https://github.com/NousResearch/hermes-agent/issues/10376>
- The **`memory` tool** has actions `add` / `replace` (substring match) / `remove`. Memory does **not** auto-compact: an over-limit write returns an error and the agent must consolidate in-turn. Entries are scanned for injection/exfiltration patterns before acceptance (they go into the system prompt).
  - Source: memory.md (above); <https://hermes-agent.org/>
- **Sessions / history** are stored in SQLite **`~/.hermes/state.db`** with **FTS5 full-text search**, queried by the **`session_search`** tool. This is keyword/FTS5, not vector, for built-in history.
  - Source: memory.md; <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md>
- The **holographic** provider uses a separate SQLite **`memory_store.db`** (`db_path` default `$HERMES_HOME/memory_store.db`) — this is the file at the center of the #4726 cross-profile bug.
- Built-in config keys (`~/.hermes/config.yaml`):
  - `memory.memory_enabled: true|false`
  - `memory.user_profile_enabled: true|false`
  - `memory.write_approval: false|true`
  - `display.memory_notifications: off|on|verbose`
  - Source: memory.md

### (b) External providers — all 9 documented
Only **one external provider is active at a time**; built-in memory stays active alongside it. Enable via `memory.provider: <name>` in `config.yaml` (or `hermes memory setup`). Config-file providers store config under `$HERMES_HOME/` so each **profile** gets its own credentials.
Source: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory-providers.md>, <https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers>

| Provider | Enable key | Config / env | Scoping key | Per-user namespacing? |
|---|---|---|---|---|
| **mem0** | `memory.provider: mem0` | `$HERMES_HOME/mem0.json`; `MEM0_API_KEY` in `~/.hermes/.env` | `user_id` (default `hermes-user`), `agent_id` (default `hermes`) | **YES** — `user_id` scopes memory; cloud + OSS modes |
| **Honcho** | `memory.provider: honcho` | `$HERMES_HOME/honcho.json` (or `~/.honcho/config.json`); `apiKey` in config | `peerName` (user), `aiPeer` (agent), `workspace`; `userPeerAliases`, `runtimePeerPrefix`, `pinUserPeer` | **YES** — strongest multi-user model (runtime peer resolution) |
| **Supermemory** | `memory.provider: supermemory` | `$HERMES_HOME/supermemory.json`; `SUPERMEMORY_API_KEY`, `SUPERMEMORY_CONTAINER_TAG` | `container_tag` (default `hermes`); `{identity}` template; `enable_custom_container_tags` + `custom_containers` | **YES** — via container tags / `{identity}` |
| **Hindsight** | `memory.provider: hindsight` | `$HERMES_HOME/hindsight/config.json`; `HINDSIGHT_API_KEY` | `bank_id` (default `hermes`) | **PARTIAL** — one bank id per profile (static), KG + `reflect` synthesis |
| **OpenViking** | `memory.provider: openviking` | env: `OPENVIKING_ENDPOINT/_API_KEY/_ACCOUNT/_USER/_AGENT` | `OPENVIKING_AGENT` (peer), `OPENVIKING_USER` | **PARTIAL** — per-profile env, not per-conversation |
| **RetainDB** | `memory.provider: retaindb` | env: `RETAINDB_API_KEY` | auto-derived profile-scoped project name | **PARTIAL** — auto per-profile, not user-controlled |
| **ByteRover** | `memory.provider: byterover` | CLI `brv`; tree at `$HERMES_HOME/byterover/` | filesystem per profile | **NO per-user** — per-profile only |
| **Holographic** | `memory.provider: holographic` | `config.yaml` `plugins.hermes-memory-store`; `db_path` (default `$HERMES_HOME/memory_store.db`) | `db_path` only | **NO** — local SQLite, the #4726 bleed surface |
| **Memori** | `memory.provider: memori` | plugin `hermes-memori`; API key via setup | project + session attribution (tool-aware) | **SPIKE** — scoping not documented in detail |

Sources: memory-providers.md (repo + hosted, above); mem0 <https://docs.mem0.ai/integrations/hermes>; Memori announcement <https://www.prweb.com/releases/memori-labs-featured-as-an-official-hermes-agent-memory-provider-giving-agents-long-term-persistent-memory-302793664.html>; provider comparison <https://www.glukhov.org/ai-systems/memory/agent-memory-providers/>.

---

## 2. What "Memorius" is

**There is no Hermes memory provider named "Memorius."** It does not appear in the official provider list (mem0, Honcho, Supermemory, Hindsight, OpenViking, RetainDB, ByteRover, Holographic, Memori).
- Closest real candidates:
  1. **Memori** (`hermes-memori`) — the **newest official** provider (Memori Labs), tool-aware memory capturing conversation + agent trace + execution. Source: <https://www.prweb.com/releases/memori-labs-featured-as-an-official-hermes-agent-memory-provider-giving-agents-long-term-persistent-memory-302793664.html>
  2. **mem0** — the mainstream provider with first-class `user_id` namespacing. Source: <https://docs.mem0.ai/integrations/hermes>
- Verdict: treat the owner's "Memorius" as a misremembered name. **For per-(agent, hirer) isolation, mem0's `user_id` model is the cleaner fit; Honcho's peer model is the most powerful for multi-user gateways.** Memori is viable but its per-tenant scoping is undocumented → **SPIKE** before trusting it as a boundary.

---

## 3. Built-in memory isolation reality (the bugs)

All three are **OPEN / NOT fixed** in current versions. Built-in memory is **not a safe tenant boundary**.

- **#4726 — shared `memory_store.db`** (holographic). Multiple profiles share one SQLite DB → facts and trust scores bleed across profiles, no attribution/filtering. OPEN (opened 2026-04-03), no maintainer fix; proposes a `namespace_mode` (`isolated`/`shared`/`hybrid`) that does not exist yet.
  - <https://github.com/NousResearch/hermes-agent/issues/4726>
- **#10376 — profile isolation broken two ways.** `--clone` copies `MEMORY.md`/`USER.md`/possibly `state.db` (docs promise "fresh memory" — false); and the agent's **file tools (`read_file`, `list_directory`, terminal) have unrestricted access across the whole `~/.hermes/` tree**, so an agent can read other profiles' files. `HERMES_HOME` isolation is **not enforced at the file-access level**. OPEN; "no configuration workaround fully resolves this."
  - <https://github.com/NousResearch/hermes-agent/issues/10376>
- **#34352 — "Solving the Multi-Tenant Hermes Problem."** On one process: **global memory** (DM facts leak into group chats), **session-key collision** (two bots → identical `agent:main:telegram:dm:{user_id}` → state bleed), and **memory ops bypass the hook system** so isolation is impossible without forking. OPEN (2026-05-29), no maintainer reply, no merged PR. Key line: *"Isolation must be enforced at the storage layer, not assumed from process separation."* Current operator workaround = **N separate processes**, one per tenant.
  - <https://github.com/NousResearch/hermes-agent/issues/34352>
- **#20060 / PR #20199 — `X-Hermes-Session-Key` → `gateway_session_key`.** Previously the API server only exposed `X-Hermes-Session-Id` (short-term transcript). **CLOSED/merged**, shipped in **v0.17** (`v2026.6.19`): a stable `X-Hermes-Session-Key` HTTP header now sets the long-term gateway/memory scope, separate from `session_id` (which `/new`/`/reset` rotate).
  - <https://github.com/NousResearch/hermes-agent/issues/20060>, releases <https://github.com/NousResearch/hermes-agent/releases>
  - **Important caveat:** `X-Hermes-Session-Key` lets the *caller* set the long-term scope key, but #34352/#4726 mean the **storage layer still doesn't enforce** that scope for built-in/holographic memory — so a stable session-key is necessary but **not sufficient** for hard isolation.
  - Related sharp edge: #13868 — `resolve_session_name` doesn't truncate, can overflow Honcho's 100-char session-id limit. Watch when deriving long composite keys.

**Conclusion:** Hermes-managed memory (built-in and the local providers) is a *convenience cache with convention-based isolation*, not a security boundary. This matches our existing memory note (bug #4726, shared `memory_store.db`, cross-profile `session_search`). OWASP LLM06 (cross-tenant memory read) is a live risk if we lean on it.

---

## 4. The RIGHT way to get per-agent + per-hirer isolated memory

### Option A — external provider with a per-(agent,hirer) namespace
- **mem0:** set `user_id` to a stable composite per hirer (e.g. `a{agent_id}_h{hirer_tg_user_id}`) and `agent_id` to the agent. With v0.17, drive the scope through **`X-Hermes-Session-Key`** so it varies per hirer instead of being a static `mem0.json` value.
- **Honcho:** map each hirer to a distinct peer via `userPeerAliases` / `runtimePeerPrefix`; `pinUserPeer: false`.
- **Maps to (agent_id, hirer_tg_user_id):** YES, cleanly.
- **Safe boundary?** Depends on the *provider's* server-side enforcement (mem0/Honcho cloud do isolate by `user_id`/peer). But **the agent could still set or read a different `user_id` if it can call the tool with arbitrary scope** — must verify scope is wired from the request, not agent-chosen. **SPIKE:** confirm Hermes passes `gateway_session_key` → provider scope and that the LLM cannot override it (this is exactly the #34352 "memory bypasses hooks" concern).

### Option B — per-profile / per-process separation
- One Hermes **profile + process per tenant** (the maintainer-acknowledged workaround in #34352). True isolation at the OS/process layer (our Docker-per-tenant plan, 5GB containers).
- **Maps to:** one container per (agent) and per-hirer session-key inside it, or one container per (agent,hirer) for maximum isolation.
- **Safe boundary?** Process/container = strong; but heavy (resident `hermes gateway` ~300–600MB each) → does **not** scale to many hirers per agent. Use for high-value tenants.

### Option C — OUR Postgres is the memory of record (RECOMMENDED)
- We keep memory + history in our DB, scoped by **`(agent_id, hirer_tg_user_id)`** (index `(agent_id, COALESCE(scope_tg_user_id,0), key)`; history filtered `tg_user_id = hirer`), **wired server-side by the worker from `runId`/session — never from the request body**, so the LLM cannot request another tenant's namespace. We inject the relevant slice into the agent context per turn and write back after.
- Hermes built-in/provider memory is treated as **disposable cache** (or disabled: `memory.memory_enabled: false`, no external provider) so no cross-tenant state accumulates inside Hermes.
- **Maps to:** exactly our existing `agent_memory (agent_id, scope_tg_user_id)` model in SECURITY.md / ARCHITECTURE.md.
- **Safe boundary?** YES — it's the only option where *we* own and enforce the boundary, immune to #4726/#10376/#34352. Matches the canon stance "our DB = source of record."

### Recommended design (single)
**Option C as the trust boundary + Option B for hard separation of the running agent.**
1. **Our Postgres = memory of record**, namespaced `(agent_id, hirer_tg_user_id)`, scope set server-side from `runId`. Inject context, never trust Hermes to isolate.
2. **Per-agent Hermes profile** (Docker-per-tenant where multitenancy matters), with a **stable `X-Hermes-Session-Key` per hirer** so Hermes' own session/memory at least lines up with our scope.
3. **Disable or treat-as-cache** Hermes built-in memory + holographic (the bleed surfaces); if an external provider is desired, prefer **mem0/Honcho with per-hirer `user_id`/peer**, but only after the SPIKE confirms the scope is request-wired, not agent-settable.

This is the same architecture our SECURITY.md already mandates (per-`(agent_id, hirer_tg_user_id)` namespace, scope wired by the worker, not the request body) — the research confirms it's the *only* safe choice given upstream Hermes isolation gaps.

---

## 5. External-provider config + scoping mechanics (mem0, the best fit)

Enable in `~/.hermes/config.yaml`:
```yaml
memory:
  provider: mem0
```
Scope/behavior in `$HERMES_HOME/mem0.json`:
```json
{ "mode": "platform", "user_id": "a<agent_id>_h<hirer_tg_user_id>", "agent_id": "<agent_id>" }
```
- `user_id` (default `hermes-user`) = the identifier that **scopes** memories; `agent_id` (default `hermes`) = tag on writes. Setting `user_id` merges that person across gateways; leaving it unset = per-gateway native id.
- Secret only: `MEM0_API_KEY` in `~/.hermes/.env` (never in `mem0.json`).
- OSS/self-host mode (no mem0 cloud):
```json
{ "mode": "oss", "oss": {
  "llm": {"provider":"openai","config":{"model":"gpt-5-mini"}},
  "embedder": {"provider":"openai","config":{"model":"text-embedding-3-small"}},
  "vector_store": {"provider":"qdrant","config":{"path":"~/.hermes/mem0_qdrant"}} } }
```
- Source: <https://docs.mem0.ai/integrations/hermes>; memory-providers.md.

**Does Hermes forward a stable per-tenant id WE control?**
- Static path: `user_id` in `mem0.json` is per-profile, **not** per-conversation.
- Dynamic path (v0.17): **`X-Hermes-Session-Key`** → `AIAgent(gateway_session_key=...)` sets the long-term memory scope per request (PR #20199). This is the lever to make scope vary per hirer.
- **Risk / SPIKE:** whether the agent (LLM) can override the scope on a `memory` tool call (read another `user_id`). #34352 says memory ops bypass the hook system → assume the agent *could* until proven otherwise. **Do not let mem0 be the sole boundary; our Postgres stays the boundary.**

---

## Gaps / SPIKE items
1. **SPIKE — scope enforcement:** does Hermes wire `gateway_session_key` into the mem0/Honcho call such that the LLM *cannot* request a different `user_id`/peer? (#34352 implies not.) Test: two hirers on one profile, try to read each other's memory.
2. **SPIKE — Memori scoping:** the newest provider's per-tenant model is undocumented. Don't adopt as a boundary until tested.
3. **SPIKE — `X-Hermes-Session-Key` on our box:** our VPS runs Hermes v0.12 (per memory `project_hermes_runtime_setup`). `X-Hermes-Session-Key` is **v0.17** — upgrade the box first (already a tracked TODO: "Hermes v0.12→v0.17 upgrade").
4. **Watch #13868:** long composite session keys can overflow Honcho's 100-char limit — keep our `(agent_id,hirer)` key short or hash it.
5. **Confirmed, no spike needed:** #4726/#10376/#34352 are OPEN → built-in/holographic memory is not a tenant boundary; our DB must be the record. (Matches canon §5/§11 + SECURITY.md.)

---

## Sources (all consulted)
- Hermes memory docs (repo): <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md>, <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory-providers.md>, <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md>
- Hosted docs: <https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers>, <https://hermes-agent.nousresearch.com/docs/user-guide/features/memory>
- mem0 integration: <https://docs.mem0.ai/integrations/hermes>
- Issues: <https://github.com/NousResearch/hermes-agent/issues/4726> · <https://github.com/NousResearch/hermes-agent/issues/10376> · <https://github.com/NousResearch/hermes-agent/issues/34352> · <https://github.com/NousResearch/hermes-agent/issues/20060> (PR #20199)
- Releases (v0.17 `v2026.6.19`): <https://github.com/NousResearch/hermes-agent/releases>
- Memori announcement: <https://www.prweb.com/releases/memori-labs-featured-as-an-official-hermes-agent-memory-provider-giving-agents-long-term-persistent-memory-302793664.html>
- Provider comparison: <https://www.glukhov.org/ai-systems/memory/agent-memory-providers/>
