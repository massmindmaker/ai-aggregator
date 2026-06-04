<!-- Generated 2026-06-04 by research subagent. Real sources cited inline (URL + date). -->
<!-- Task: research latest Hermes (NousResearch/hermes-agent) vs our canon pin v0.15.2, answer the managed-Hermes remote-API + footprint questions, and give a go/no-go verdict against docs/specs/2026-06-04-managed-hermes-spike-plan.md -->

# Hermes Updates — research for managed-Hermes go/no-go (2026-06-04)

> **Scope:** answers the founder's explicit ask — is managed-Hermes now more viable? Verdict at the bottom. Every claim is grounded in a real current source (GitHub releases API, README on `main`, official docs). Where a number is NOT published, it is flagged as **UNVERIFIED — must measure in the spike**.

## Sources (real, current)
- GitHub releases (live API, fetched 2026-06-04): `gh api repos/NousResearch/hermes-agent/releases` — latest tag `v2026.5.29.2` = **v0.15.2**, published 2026-05-29.
- README on `main`: https://github.com/NousResearch/hermes-agent/blob/main/README.md (fetched 2026-06-04).
- v0.15.0 "Velocity Release" notes: GitHub release `v2026.5.28` body (fetched 2026-06-04 via API).
- Subscription-proxy doc: https://hermes-agent.nousresearch.com/docs/user-guide/features/subscription-proxy (fetched 2026-06-04).
- Configuration doc: https://hermes-agent.nousresearch.com/docs/user-guide/configuration (fetched 2026-06-04).
- Architecture doc: https://hermes-agent.nousresearch.com/docs/developer-guide/architecture (fetched 2026-06-04).
- `hermes proxy` port confirmation: blakecrosley.com/guides/hermes + hermesagents.net (fetched 2026-06-04).

---

## (1) Latest version + what changed since ~v0.15.2

**Our canon pin v0.15.2 IS the latest** (published 2026-05-29; the repo uses date-tags `v2026.5.29.2`). So there is no newer release to "catch up to" — but a LOT changed across the v0.13→v0.15 wave that our spike plan predates:

| Ver | Date | Codename | Headline (since v0.12) |
|---|---|---|---|
| v0.15.2 | 2026-05-29 | (hotfix) | dashboard 401 reload-loop fix, Docker insecure opt-in |
| v0.15.1 | 2026-05-29 | The Patch Release | `/model` + `hermes model` unified picker w/ disk cache |
| **v0.15.0** | 2026-05-28 | **The Velocity Release** | 1,302 commits. `run_agent.py` 16,083→3,821 LOC (-76%). Kanban → real multi-agent platform. Cold-start wave. `session_search` 4,500× faster. Promptware/prompt-injection defense. |
| v0.14.0 | 2026-05-16 | Foundation | `hermes proxy` (OpenAI-compat OAuth proxy), native Windows beta, generic platform-plugin hooks, sessions survive restarts, ~19s off launch |
| v0.13.0 | 2026-05-07 | Tenacity | multi-agent Kanban, `/goal` persistence, 20th platform |

Most relevant deltas for us:
- **Cold-start got dramatically faster** (v0.15.0): deferred imports (−240ms/−17MB per CLI invocation), 47% fewer per-turn function calls, Termux cold start 2.9s→0.8s, `hermes --version` 701ms→258ms. This directly improves the spike's cold-start metric.
- **Built-in cron scheduler** with delivery to any platform, **scheduled task start times**, **per-job profile cron** (v0.13–v0.15) — this is exactly the "agent works by itself in the morning" feature we listed as blocked.
- **Kanban multi-agent platform**: swarm topology, worktree-per-task, per-task model overrides, scheduled tasks. Exposes HTTP endpoints `/workers/active`, `/runs/{id}`, `/inspect` — but see (2): these are kanban-orchestration endpoints, NOT an agent-config control plane.
- **Promptware/prompt-injection defense** (v0.15.0, `tools/threat_patterns.py`, delimiter markers on tool output, recalled-memory scanning) — partially relevant to our multi-tenant secret-isolation worry, but it is context-window hygiene, NOT process/OS isolation.
- **Sessions survive gateway restart** + `platform_message_id` persistence — helps the sleep/wake story.

## (2) THE KEY QUESTION — remote config / control REST API? → **STILL NO.**

**Our blocker stands.** Hermes still has **no inbound HTTP/REST control API** to set the model / start-stop / provision per-user / change persona-tools-MCP over the network. Configuration is **files + CLI on the host**, unchanged from our canon:
- Config doc (2026-06-04): "Configuration appears strictly local-file and CLI-based — no network-based remote configuration mechanism." It lives in `~/.hermes/config.yaml` + `~/.hermes/.env`; you change the model with `hermes config set` / `hermes model` (CLI), precedence = CLI args > config.yaml > .env > defaults.
- Architecture doc (2026-06-04): the gateway is "a long-running process with 20 platform adapters, session routing, authorization, slash-command dispatch, hook system, cron ticking" (`gateway/run.py`, `GatewayRunner`). No documented REST control surface.

What IS exposed over HTTP — and why none of it replaces the control plane we must build:
- **`hermes proxy` (port `127.0.0.1:8645`)** — confirmed **OUTBOUND** credential adapter. It exposes an OAuth subscription (Nous Portal / xAI-Grok / Claude Pro) as an OpenAI-compatible endpoint *for other tools to consume*. The doc is explicit: "outbound passthrough… not inbound control… It cannot configure the Hermes agent itself or change its settings over the network… no agent loop, no transformation." So this is the opposite direction from what we need.
- **OpenAI-compatible chat** — still the way TMA/agent-worker would *talk to* a running Hermes (run a turn), exactly as our canon says. Not config.
- **Kanban endpoints** (`/workers/active`, `/runs/{id}`, `/inspect`) — task orchestration telemetry, not "set this agent's model/soul."
- **Dashboard** (web UI; the v0.15.2 hotfix was a dashboard 401 loop) — a local browser UI, not a documented machine-to-machine provisioning API.

**Conclusion for (2):** §4 of the spike plan ("CONTROL-PLANE, КОТОРЫЙ ПРИДЁТСЯ ПОСТРОИТЬ") is **still required, unchanged**. We still must build the small host-side daemon that writes `~/.hermes/config.yaml` / `SOUL.md`, runs the CLI, and manages process lifecycle. The spike step §3.4 (confirm "config can't be changed over the network") will still come back **NO** — as expected.

## (3) Resource footprint — sleep/wake / lighter mode / multi-tenant

- **No official per-instance RAM number is published** in README/docs/release notes (grep across all three turned up none). Our ~300–600MB resident figure remains **UNVERIFIED triangulation — the spike must measure it.** The only footprint signal is marketing: "Run it on a **$5 VPS**" (README), which implies a single instance fits in ~1GB, but says nothing about *N* concurrent instances or idle RSS — exactly the unknown the spike exists to resolve.
- **Cold-start materially improved** (v0.15.0, see above). Good for the "sleep → wake" tier; lowers the risk on the spike's cold-start threshold (≤10s).
- **The big new lever = serverless hibernation.** README confirms six terminal backends — local, Docker, SSH, Singularity, **Modal**, **Daytona** — and: "Daytona and Modal offer serverless persistence — your agent's environment **hibernates when idle and wakes on demand, costing nearly nothing between sessions**." This is the most important footprint change vs our plan: it offers a path where idle agents cost ≈$0 instead of holding ~300–600MB resident on our box.
  - **BUT the D-2 caveat in our canon still bites:** our `/CLAUDE.md` records that Daytona sandboxes only the *tools* while the `hermes gateway` stays **resident**. The README's "environment hibernates" language is about the *terminal backend* (where the agent's shell/tools run), and is **not explicitly confirmed to hibernate the long-running messaging gateway** that holds Telegram/Discord sessions. So serverless-idle helps the heavy tool side; whether it zeroes out the *gateway* RSS per tenant is still **UNVERIFIED — must test in the spike.**
- **Multi-tenant:** still no first-class "one process, many isolated tenants" mode. v0.15.0 adds a TUI **multi-session orchestrator** (multiple sessions in one TUI window) and the **multi-agent Kanban swarm**, but these are multi-*session/agent within one user's host*, not multi-*customer tenancy with secret isolation*. Our file-isolation / `.env`-leak concern is unchanged; the new Promptware defenses are context-window hygiene, not OS-level tenant isolation.

## (4) Telegram + platform bridges — status

**Unchanged and still a reason NOT to build our own chat bridge.** Telegram is a first-class native adapter, alongside Discord, Slack, WhatsApp, Signal, Email/CLI, plus Matrix, Home Assistant, Google Chat, LINE, SimpleX, and **ntfy (the 23rd platform, v0.15.0)** — "all from a single gateway process," with voice-memo transcription and cross-platform conversation continuity. (Counts vary by how you tally: README's hero list names 6, the architecture doc says "20 platform adapters," release notes say "23rd messaging platform" — all consistent that Telegram is built-in and the bridge count grew.) **Spike-plan §4 "не строить чат-мост" stays correct.**

## (5) Daytona / sandbox integration — status

Confirmed first-class: **Daytona and Modal are two of the six terminal backends**, both offering serverless persistence/hibernation (idle→wake, "costing nearly nothing"). Modal additionally targets GPU compute (cost-nothing-when-idle, bills per-second). NovitaAI "Agent Sandbox" is also referenced as a provider. This is the same D-2 picture as our canon, now confirmed as a shipped, documented capability rather than aspiration — **it is a real option for the "sandbox the tools, $-bill the foreign entity" path** in spike-plan §2 variant 3, with the standing caveat from (3) that the resident gateway likely is NOT what hibernates.

---

## (6) VERDICT — does this change the spike plan or the go/no-go?

**No material change to the plan; the spike is still required and the go/no-go threshold stands — but two inputs improved and one new path opened.**

1. **The core blocker is intact.** No remote config/control API exists (still files+CLI in `~/.hermes/`), so spike-plan §4 (build our own host-side control-plane daemon) remains mandatory, and §3.4 will still confirm "can't drive config over the network." Nothing here lets us skip building the control plane.
2. **The go/no-go number is still unmeasured.** No official idle-RSS figure is published; our ~300–600MB stays triangulation. The **>800MB idle = no-go** threshold (spike-plan §3) is unchanged and still decided by the spike, not by docs.
3. **Two tailwinds reduce risk:** (a) v0.15.0 cold-start wins make the ≤10s cold-start threshold easier and strengthen a "sleep/wake" tier; (b) cron/scheduled-tasks now ship natively, so the "agent works unattended" feature is closer to buildable once a box exists.
4. **One new strategic option:** Daytona/Modal **serverless hibernation** is now confirmed-shipped. It is worth **adding an explicit spike step**: measure whether the *resident gateway* (not just the tools) actually hibernates to ≈0 idle cost on Daytona/Modal — if yes, it could beat the "rent a 16GB box" variant on idle economics and shift $-cost to the foreign entity. If the gateway stays resident (per our D-2 caveat), the box variant still wins for the first test.

**One-line recommendation:** keep the spike plan as-is; pin stays v0.15.2 (it's the latest); add a single sub-experiment to the spike — "does Daytona/Modal hibernate the gateway RSS, or only the tool sandbox?" — because that is the only update that could change the *provisioning variant* (§2) we pick.
