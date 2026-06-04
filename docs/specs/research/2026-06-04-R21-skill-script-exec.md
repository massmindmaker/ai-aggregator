# R-21 — Executable SKILL scripts: how they run & the minimal safe model for us

> Research for skills-catalog item #29 — the **«скоро»** part: executable `scripts/` bundles
> (agentskills.io / Claude Skills allow a `scripts/` folder the agent can EXECUTE).
> Cross-references **R-14** (eval-sandbox isolation) and **R-15** (skills-hub format/mapping).
> **Date:** 2026-06-04 · **Status:** advisory · sources cited inline with access date.
>
> **Question:** (1) how do Claude Skills / agentskills.io actually EXECUTE bundled scripts;
> (2) the isolation needed to run UNTRUSTED skill scripts safely; (3) is there a safe subset
> buildable NOW without a full sandbox; (4) the honest verdict — what infra unlocks it.

---

## TL;DR

1. **How they run:** A skill bundles a `scripts/` folder; the agent runs scripts **via plain
   `bash`** (`python3 scripts/x.py`, `bash scripts/y.sh`, `uv run …`) and reads only
   **stdout/stderr** back into context — the script source never enters the prompt. There is **no
   special "skill VM"**: execution is whatever shell the host gives the model. The single control
   is **WHERE that bash runs**. On the Claude **API**, that is Anthropic's **code-execution
   container** (Linux, 5 GiB RAM / 1 CPU / 5 GiB disk, **internet completely disabled**, full
   host isolation, 30-day workspace-scoped lifetime). In **Claude Code** it is the user's own
   machine with **full network + filesystem** — i.e. *no isolation at all*. (Sources: Anthropic
   Agent-Skills overview + code-execution-tool docs; agentskills.io spec/using-scripts.)
2. **Isolation needed for UNTRUSTED scripts:** the established ranking (R-14) holds —
   **Firecracker microVM > gVisor > hardened container/nsjail > language-runtime sandbox** — and
   the *highest-ROI single control is killing network egress*, exactly what Anthropic's own skill
   sandbox does (internet **completely disabled**). Shared-kernel Docker/`nsjail` alone is **not**
   safe for arbitrary code. None of this may live on our 2 GB prod box (money path).
3. **Safe subset buildable NOW (no sandbox):** **yes, two of them.** (a) **Declarative-only
   "scripts"** = a SKILL that ships *no arbitrary code*, only a **named sequence of our already-vetted
   built-in tools / MCP calls** (a recipe the runner replays) — zero new exec surface. (b) **Delegate
   execution to a connected user's OWN Hermes** (BYO-runtime): the script runs on *their* machine
   under *their* trust + Hermes's own pre-install security scanner, not ours — and BYO = 0 commission
   anyway. Both are honest-shippable today.
4. **Honest verdict / what unlocks the *general* case:** running an arbitrary author's
   `scripts/` bundle for a *random user* requires a **separate, network-less, disposable host**
   running **gVisor (`runsc`, systrap)** per-run throwaway containers (Phase-0), escalating to
   **Firecracker microVMs on a KVM/bare-metal host** for volume/native-binaries (Phase-1) — i.e.
   the **same infra R-14 specs for the eval-runner**. Until that host exists, keep general
   executable-`scripts/` behind an `R&D`/«скоро» label.

---

## 1. How Claude Skills / agentskills.io actually EXECUTE bundled scripts

### 1.1 The mechanism is "bash + progressive disclosure", not a bespoke runtime

Per the agentskills.io spec and Anthropic's overview, a skill is a folder; `scripts/` holds
"executable code that agents can run." Execution is by **ordinary shell invocation** that the
SKILL.md instructs the agent to issue — relative-path from the skill root:

```markdown SKILL.md
## Workflow
1. bash scripts/validate.sh "$INPUT_FILE"
2. python3 scripts/process.py --input results.json
```

Anthropic states it plainly: *"When instructions mention executable scripts, Claude runs them
**via bash** and receives only the output (the script code itself never enters context)."* This
is the **Level-3** stage of progressive disclosure:

| Level | When loaded | Cost | Content |
|---|---|---|---|
| 1 Metadata | always (startup) | ~100 tok/skill | `name`+`description` frontmatter |
| 2 Instructions | when skill triggered | <5k tok | SKILL.md body |
| 3 Resources/**code** | as needed | "unlimited" | `scripts/`/`references/`/`assets/` — **scripts executed via bash, output-only into context** |

(Source: platform.claude.com Agent-Skills overview; agentskills.io/specification — both accessed 2026-06-04.)

**Runtime & languages:** "Supported languages depend on the agent implementation. Common options
include Python, Bash, and JavaScript." Self-contained scripts declare deps inline — Python
**PEP 723** (`uv run scripts/x.py`), Deno `npm:`/`jsr:` specifiers, Bun auto-install, Ruby
`bundler/inline` — so the agent runs them with **one command, no separate install step**. Scripts
**must be non-interactive** (agents run in non-interactive shells; a TTY prompt hangs forever),
should emit **structured stdout** + diagnostics on **stderr**, document a `--help`, and use
meaningful exit codes. (Source: agentskills.io/skill-creation/using-scripts, accessed 2026-06-04.)

### 1.2 The `allowed-tools` frontmatter field (experimental)

`allowed-tools` is an **optional, experimental** space-separated allowlist of *pre-approved
tools the skill may invoke*, e.g. `allowed-tools: Bash(git:*) Bash(jq:*) Read`. Per the spec:
*"Support for this field may vary between agent implementations."* It is a **host-side permission
hint**, not a sandbox: it can narrow *which* bash commands the harness will auto-approve, but it
does **not** itself contain a malicious script — a script the agent is allowed to run can still do
anything the *process* is allowed to do. (Source: agentskills.io/specification, accessed 2026-06-04.)

### 1.3 The isolation is 100% a property of WHERE bash runs — and the two reference surfaces differ sharply

This is the load-bearing finding. Anthropic ships the **same SKILL.md** to two very different
execution environments:

| Surface | Execution host | Network | Filesystem | Isolation |
|---|---|---|---|---|
| **Claude API** (code-execution tool, beta `code-execution-2025-08-25` + `skills-2025-10-02`) | Anthropic's **sandboxed Linux container** | **Internet completely disabled — no outbound requests** | workspace dir only | **Full isolation from host & other containers**; 5 GiB RAM / 1 CPU / 5 GiB disk; container workspace-scoped to the API key, expires 30 days | 
| **Claude Code** | the **user's own machine** | **full network access** ("same as any other program on the user's computer") | full FS | **none** — relies on user trust + per-command approval |
| **claude.ai** | code-exec container, **off by default** (Settings → Features); network varies by admin/user setting | varies | workspace | container, but capability gated |

(Sources: platform.claude.com code-execution-tool — "Internet access: **Completely disabled for
security** … **Full isolation from host system and other containers**", 5 GiB/1 CPU/5 GiB;
Agent-Skills overview "Runtime environment constraints" — API = **no network, no runtime package
install**, Claude Code = **full network access**; both accessed 2026-06-04.)

**Takeaway:** Anthropic's *managed* answer to "run untrusted skill scripts" is exactly a
**network-less, host-isolated, resource-capped container** — they pay the isolation cost on a
separate fleet, not on the box that holds secrets. Claude Code's answer is *"it's your machine,
your trust"* — which is precisely the **BYO-Hermes** posture for us (see §3.2).

### 1.4 The standard's own security stance

Anthropic: *"Use Skills only from trusted sources… a malicious Skill can direct Claude to invoke
tools or execute code in ways that don't match the Skill's stated purpose"*; audit **all** bundled
files; **external-URL-fetching skills are the highest risk** (fetched content may carry injected
instructions); *"treat like installing software."* Hermes (R-15) goes further and **scans every hub
skill for data-exfiltration / prompt-injection / destructive commands before install**. The
standard offers **no runtime sandbox of its own** — it assumes the host provides one.
(Sources: platform.claude.com Agent-Skills "Security considerations"; R-15 §1.5, accessed 2026-06-04.)

---

## 2. Isolation needed to run UNTRUSTED skill scripts safely (cross-ref R-14)

Executable `scripts/` from an arbitrary author = **arbitrary untrusted code execution** —
the same threat class R-14 analysed for the contest/eval runner. R-14's ranking and verdict
apply unchanged:

**Firecracker (HW virt) > gVisor (userland kernel) > hardened Docker/nsjail (shared kernel) >
language-runtime sandbox.** Key per-source facts (from R-14, re-confirmed):

- **Plain Docker / `runc` is not a sandbox for untrusted code** — shared host kernel; one kernel
  bug or misconfig = container escape → host + secrets. Consensus (2025-26) is that shared-kernel
  isolation "isn't cutting it" for untrusted AI-generated code; **Firecracker microVMs or Kata are
  the production answer** (Northflank, SoftwareSeni, Fly.io, accessed 2026-06-04).
- **gVisor (`runsc`, systrap platform)** — userland re-implemented kernel; **runs on an ordinary
  VPS with no nested KVM**; "low-double-digit %" CPU hit, worse for syscall/network-heavy jobs;
  the **best pragmatic** second kernel boundary. (gvisor.dev platforms/performance, 2026-06-04.)
- **Firecracker microVM** — separate guest kernel, **<5 MiB overhead, ~125 ms boot, 150 VM/s/host**,
  but **needs hardware virt (KVM)** → a **dedicated/bare-metal host** (Timeweb cloud VPS usually
  does NOT expose nested KVM — verify `/dev/kvm`). Gold standard. (firecracker-microvm.github.io.)
- **`nsjail` alone is insufficient** — a toolkit (namespaces+seccomp+cgroups+rlimits), security
  = your config; useful only as an *inner* layer under gVisor/Firecracker. (github.com/google/nsjail.)
- **The single highest-ROI control is cutting network egress** (Fly.io) — and it is exactly what
  Anthropic's own skill sandbox does (§1.3, internet *completely disabled*). Most skill scripts
  (format a doc, transform data, run a linter) need **zero egress**.

**Minimal safe execution model (untrusted, general case):**
> a **network-less** (`--network none`), **read-only-rootfs**, **non-root + user-namespaced**,
> **all-caps-dropped**, **seccomp-restricted**, **cgroup mem/CPU/pids-capped**, **wall-clock +
> CPU-time-bounded**, **no-host-mounts, zero-secrets-in-env** throwaway OCI container, wrapped by
> **gVisor `runsc`** (Phase-0) → **Firecracker microVM** (Phase-1), on a **SEPARATE disposable
> host with no route to the prod DB / gateway / Redis** — **never the 2 GB prod box.**

Co-tenancy verdict (from R-14, binding): the prod VPS runs the live money path
(`settleRun`, `AIAG_GATEWAY_KEY`, `TMA_JWT_SECRET`, BYOK AES keys in `/srv/aiag/shared/.env`) on
2 GB with no headroom; **attacker-controlled code must never share that kernel/host.** A single
escape on a shared box reaches every secret. This is also why `/SECURITY.md`'s "eval-runner nsjail
sandbox" is still an open TODO, and why item #29's `scripts/` is correctly deferred.

---

## 3. Is there a safe subset buildable NOW (no full sandbox)?

**Yes — two distinct subsets, both honest-shippable on current infra, neither runs arbitrary author code on our box.**

### 3.1 Subset A — Declarative "scripts" = vetted tool-call recipes (NO arbitrary code)

Reframe a v1 executable skill as **a named, ordered sequence of calls to our *already-vetted*
primitives**, not a code blob:

- The only callable units are the **4 built-in tools** (`web_search`, `calc`, `image_gen`,
  `memory` — `tools.ts`) and a **pre-vetted MCP endpoint** (read-only `mcp-client.ts`, `safeFetch`
  SSRF-guard, ≤32 tools, 15 s, 8 k cap). All of these are **already in production and already
  sandboxed/guarded** (e.g. `calc` is a whitelisted-charset eval; `code_interpreter` stays
  `UNIMPLEMENTED` on purpose — *"arbitrary code execution is a security risk we don't take on"*,
  `tools.ts:88-92`).
- A "script" is then **data, not code**: a JSON/DSL recipe — e.g. `[web_search → memory.set →
  image_gen]` — that the stateless runner replays through the **existing** `executeTool` path.
  No new interpreter, no shell, **no new attack surface** beyond what MCP-v1 already passed
  security review. This is essentially how Hermes's `fallback_for_toolsets` / MCP-backed skills
  already behave (R-15 §1.5) and matches R-15's v1 framing: *"a skill in OUR product v1 = a bundle
  of {built-in tools + knowledge doc + MCP}, NOT arbitrary code."*
- **Storage/auth/monetization all reuse the shipped template hub** (`agent_templates`,
  share-spec, no-secret-columns; clone/rent/rating). Adopt the agentskills.io frontmatter verbatim
  (`name`/`description`/`license`/`metadata`) so a real SKILL.md imports cleanly later.

**Limit (be honest):** this executes only *our* allowlisted operations. It is NOT general
SKILL.md `scripts/` (no `python3 scripts/x.py`). It covers the large, useful middle — "do these
known steps in order" — without a sandbox. Anything needing a real `scripts/extract.py` stays in §4.

### 3.2 Subset B — Delegate execution to the user's OWN Hermes (BYO-runtime)

For users who **connect their own Hermes** (the live, on-strategy path per `/CLAUDE.md`):

- Hermes is **already agentskills.io-compatible**, stores skills in `~/.hermes/skills/`, runs the
  bundled `scripts/`, and **scans every hub skill for exfiltration/prompt-injection/destructive
  commands before install** (R-15 §1.5). The execution + isolation + trust decision happen **on
  the user's machine, under the user's account** — *not on our infra*.
- Our role shrinks to **publishing the SKILL.md share-spec** (which we already do, secret-free)
  and letting their Hermes install/run it. This is the same posture as **Claude Code** (§1.3):
  "your machine, your trust." Per the commission rule, **BYO-runtime = 0 commission** anyway, so
  there is no money-path entanglement.
- **Limit:** only serves connect-your-own-Hermes users; does nothing for the no-runtime majority
  on the stateless loop. But it is a *genuine* executable-`scripts/` story we can ship with **zero
  new isolation infra**, because we host none of the execution.

### 3.3 What is NOT a safe subset (reject)

- Running author `scripts/` **in the `agent-worker` process / on the prod box** — even "just bash",
  even with `allowed-tools` — is rejected: shared kernel with the money path (§2). `allowed-tools`
  is a permission hint, not a boundary (§1.2).
- A **language-level sandbox** (vm2/isolated-vm/restricted-Python) as the *only* boundary — these
  have a long history of escapes and are bottom of the R-14 ranking; never the sole control for
  untrusted code.

---

## 4. Honest verdict — what infra unlocks the general case

| Capability | Buildable now? | Needs |
|---|---|---|
| **Declarative tool-recipe "skills"** (Subset A) | **Yes** — reuse `executeTool` + template hub | 1 migration + a recipe-replay path; label `live` |
| **Author `scripts/` run on user's own Hermes** (Subset B) | **Yes** — we only publish the spec | nothing new on our side; label `live (your Hermes)` |
| **Knowledge-doc SKILL.md** (no code) | **Yes** (R-15 §4.1) | prepend body to system prompt; label `live` |
| **General: arbitrary author `scripts/` run for any user on OUR infra** | **No** | **A separate, network-less, disposable host** running **gVisor `runsc`(systrap) throwaway containers** (Phase-0) → **Firecracker microVMs on a KVM/bare-metal host** (Phase-1), per the R-14 defence-in-depth checklist (`--network none`, RO rootfs, non-root+userns, caps-dropped, seccomp, cgroup caps, hard timeout, zero secrets, no route to prod DB/gateway/Redis). Closes `/SECURITY.md`'s eval-runner-nsjail TODO. |

**Bottom line:** the executable-`scripts/` blocker is **operational, not conceptual** — it is the
*same* missing sandbox host R-14 specs for the contest/eval runner. We should **(1) ship Subset A
(declarative tool-recipes) + Subset B (BYO-Hermes execution) now under `live` labels**, **(2) keep
general arbitrary-`scripts/` behind `R&D`/«скоро»**, and **(3) when (and only when) we stand up the
separate gVisor host R-14 already designed, light up general `scripts/` on THAT host — never the
2 GB prod box.** No new research is required to start: Subset A/B need no sandbox; the general case
reuses an isolation design we have already specified.

---

## Recommended minimal-safe-execution model (one paragraph)

**Do not execute any untrusted author `scripts/` on the 2 GB prod box, ever** — it shares a kernel
with the live money path. Ship the safe subset *now*: (A) "executable skills" v1 = **declarative
recipes over our already-vetted built-in tools + read-only MCP**, replayed through the existing
`executeTool` path (data, not code → no new attack surface), and (B) for connect-your-own-Hermes
users, **delegate real `scripts/` execution to their own Hermes** (their machine, their trust,
Hermes's own pre-install scanner, BYO = 0 commission). Keep general arbitrary-`scripts/` behind an
`R&D`/«скоро» label. The moment we want it for everyone, run it on a **SEPARATE network-less
disposable host** with **gVisor `runsc` (systrap) per-run throwaway containers** — hardened exactly
as R-14's checklist (`--network none`, RO rootfs, non-root+userns, all-caps-dropped, seccomp,
cgroup mem/CPU/pids caps, hard wall-clock timeout, zero secrets in env, no route to prod
DB/gateway/Redis) — and escalate to **Firecracker microVMs on a KVM/bare-metal host** only for
volume or native binaries. Mirror Anthropic's own skill sandbox as the design target: **internet
completely disabled + full host isolation + tight resource caps.**

---

## Sources (all accessed 2026-06-04)
- Anthropic Agent-Skills overview (progressive disclosure 3 levels; runtime constraints API=no-network/no-install vs Claude Code=full-network; security considerations) — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Anthropic Code-execution tool (sandbox container: Linux, **5 GiB RAM / 1 CPU / 5 GiB disk**; **internet completely disabled**; **full isolation from host & other containers**; workspace-scoped; 30-day expiry; beta headers `code-execution-2025-08-25`/`skills-2025-10-02`/`files-api-2025-04-14`) — https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool
- Anthropic "Equipping agents for the real world with Agent Skills" (scripts run via bash, output-only into context; trust-source guidance) — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- agentskills.io Specification (`scripts/` dir; `allowed-tools` experimental space-separated allowlist; progressive-disclosure token budgets; frontmatter fields) — https://agentskills.io/specification
- agentskills.io "Using scripts in skills" (bash invocation, relative paths, PEP 723 / Deno / Bun / Ruby inline-deps, non-interactive requirement, structured stdout/stderr, exit codes) — https://agentskills.io/skill-creation/using-scripts
- Isolation tech (Firecracker>gVisor>container/nsjail>runtime-sandbox; network-egress = highest-ROI control; Docker shared-kernel not safe for untrusted code) — Northflank, SoftwareSeni, Fly.io sandboxing writeups; gvisor.dev; firecracker-microvm.github.io; github.com/google/nsjail
- Cross-refs: `docs/specs/research/2026-06-04-R14-eval-sandbox.md`, `…-R15-skills-hub.md`
- Our code: `apps/agent-worker/src/tools.ts` (`UNIMPLEMENTED_TOOLS = {'code_interpreter'}` — arbitrary exec deliberately refused, lines 88-92), `apps/agent-worker/src/mcp-client.ts` (read-only MCP, safeFetch SSRF guard); `/SECURITY.md` (eval-runner nsjail TODO); `/CLAUDE.md` (2 GB box, stateless loop, no managed Hermes)

## Verification flags
- API code-exec container specs (5 GiB/1 CPU/5 GiB, internet-disabled, full isolation, 30-day) are from Anthropic's **own** docs — authoritative for the API surface, but the exact same container is **not** guaranteed for claude.ai (network "varies by admin/user setting") — confirm per surface before assuming no-egress.
- `allowed-tools` is explicitly **experimental**; behaviour differs across agent implementations — do not treat it as a security boundary.
- Firecracker numbers (<5 MiB / ~125 ms / 150 VM-s) are vendor figures, workload-dependent (per R-14) — re-benchmark before capacity planning; confirm Timeweb `/dev/kvm` before choosing Firecracker.
- Hermes's "scans every hub skill before install" is from Hermes docs (R-15) — verify the scanner's actual coverage before relying on it as our only trust control in Subset B.
