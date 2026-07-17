# MemoryOS as the knowledge-base / long-term-memory layer — grounded research (2026-06-26)

> Scope: founder decision *"для баз знаний используем MemoryOS"*. Identify exactly what MemoryOS is, whether it fits **knowledge bases (RAG/docs)** or **conversational memory**, how it integrates with Hermes + our agent-worker, how per-`(agent, hirer)` isolation is enforced (OWASP LLM06), and an honest MVP→full design + effort.
> Method: grounded in the project repos (BAI-LAB/MemoryOS, MemTensor/MemOS), arXiv papers, PyPI, and our own verified Hermes-memory research (`docs/superpowers/specs/2026-06-24-hermes-memory-isolation.md`). Every load-bearing claim has a URL; open items are flagged **SPIKE**.

---

## TL;DR for the build

- **There are TWO different "memory OS" projects and the name collides.** The one literally called **"MemoryOS"** is the academic **BAI-LAB/MemoryOS** (EMNLP 2025 Oral, arXiv 2506.06326). A *different* project, **MemTensor/MemOS** ("MemOS"), is the one that actually has a real document/URL **knowledge base**. Pick deliberately — the founder said "MemoryOS" (= BAI-LAB), but BAI-LAB is **conversational memory, NOT a document knowledge base**.
- **BAI-LAB/MemoryOS = conversational long-term memory**, not RAG-over-docs. It stores `(user_input, agent_response)` pairs into a short/mid/long-term hierarchy and synthesizes a user profile. It does **not** ingest uploaded files/PDFs. So it does **not**, by itself, satisfy a "Базы знаний → upload docs" feature. URL: <https://github.com/BAI-LAB/MemoryOS>, <https://arxiv.org/abs/2506.06326>.
- **MemTensor/MemOS = the one with a real KB**: "long-term memory from documents and URLs", multi-cube KB management with isolation + controlled sharing, REST API server, 10k stars, v2.0.20 (2026-06-18), Apache-2.0. URL: <https://github.com/MemTensor/MemOS>, <https://arxiv.org/abs/2507.03724>.
- **Neither is a built-in Hermes memory provider.** Hermes ships 9 providers (mem0, Honcho, Supermemory, Hindsight, OpenViking, RetainDB, ByteRover, Holographic, Memori) — MemoryOS/MemOS is **not** among them (see our `2026-06-24-hermes-memory-isolation.md`). So we run it as a **separate service our agent-worker calls** (a tool), not via `memory.provider:`.
- **Isolation stays OUR responsibility regardless of vendor.** Both projects scope by a caller-supplied `user_id` (+ `mem_cube_id` in MemOS). That is convention, not a hard boundary — and the LLM must never choose the scope. Same conclusion as the Hermes research: **our Postgres is the source-of-record; the scope key is wired server-side from `runId`, never from the request body.**
- **Recommendation:** for the **"Базы знаний" (upload docs / KB) feature** the founder wants to make real, **BAI-LAB MemoryOS is the wrong tool** (it's conversational). Use **MemTensor/MemOS** for the KB, *or* a thin Postgres+pgvector RAG of our own. Use **BAI-LAB MemoryOS (or mem0) only if the goal is conversational long-term memory**. Below I cover both and recommend a path.

---

## 1. What MemoryOS is exactly (with URLs) — disambiguation first

### Candidate A — **BAI-LAB/MemoryOS** (the literal "MemoryOS")
- **Identity:** "Memory OS of AI Agent", EMNLP 2025 **Oral**. Authors Jiazheng Kang, Mingming Ji, Zhe Zhao, Ting Bai (BAI-LAB, Beijing Univ. of Posts & Telecom).
  - Paper: <https://arxiv.org/abs/2506.06326> · <https://arxiv.org/html/2506.06326v1>
  - Repo: <https://github.com/BAI-LAB/MemoryOS> (≈1.5k stars), **Apache-2.0**, latest **V1.2 (2025-07-18)**.
- **Core model:** a 4-module pipeline — **Storage · Updating · Retrieval · Generation** — over a 3-tier hierarchy:
  - **STM** (short-term): real-time dialogue, chain-linked.
  - **MTM** (mid-term): topic-segmented, similarity-grouped, **heat-scored**. STM→MTM = dialogue-chain **FIFO**.
  - **LPM** (long-term persona memory): persistent user profile + knowledge. MTM→LPM = **segmented-page** strategy.
  - LoCoMo benchmark: **+49.11% F1 / +46.18% BLEU-1** vs GPT-4o-mini baselines, with fewer LLM calls/tokens. (arXiv abstract.)
- **What it ingests:** **conversation pairs only.** Core API: `add_memory(user_input, agent_response)`, `retrieve_memory(query)`, `get_response(query)`, `get_user_profile()`. **No document/file upload.** (README via <https://github.com/BAI-LAB/MemoryOS/blob/main/README.md>.)
- **Self-hostable / SDK:** Yes — Python library (`pip install memoryos-pro`), **Docker**, a **Playground** GUI, and **`memoryos-mcp`** (MCP server exposing `add_memory` / `retrieve_memory` / `get_user_profile`). Storage = **local files** for STM/MTM/LPM + **ChromaDB** for vectors (added Jul 2025); embeddings via `BAAI/bge-m3`, `Qwen/Qwen3-Embedding-0.6B`, or `all-MiniLM-L6-v2`. Needs an LLM (OpenAI/Anthropic/DeepSeek/Qwen, or local via vLLM) to do updating/generation — so "self-host" means "self-host the memory engine, still point it at an LLM."
  - MCP: <https://pypi.org/project/memoryos-mcp/> · piwheels <https://www.piwheels.org/project/memoryos-mcp/>
- **Maturity:** research-grade reference impl with real tooling. ~1.5k stars, single-lab maintenance, beta. Fine for a self-hosted experiment; not a hardened multi-tenant SaaS.

### Candidate B — **MemTensor/MemOS** (the KB-capable one, often confused with "MemoryOS")
- **Identity:** "MemOS: A Memory OS for AI System", arXiv 2507.03724 / 2505.22101.
  - Repo: <https://github.com/MemTensor/MemOS> (≈10k stars), **Apache-2.0**, latest **v2.0.20 (2026-06-18)**. Cloud at memos.openmem.net.
  - ⚠️ The PyPI package literally named **`MemoryOS` v2.0.x** and the "Multi-Cube Knowledge Base" marketing actually belong to **this** project's ecosystem — this is the source of the name collision in search results. (<https://pypi.org/project/MemoryOS/> rendered as MemOS feature copy.)
- **Core unit = MemCube:** a composable memory unit (semantic payload + metadata) with lifecycle governance + access control. **Multi-Cube KB management** = manage multiple **knowledge bases** as cubes, with **isolation, controlled sharing, dynamic composition** across users/projects/agents.
- **What it ingests:** **real KB** — "long-term memory from **documents and URLs**" (RAG-style), plus conversational + multi-modal (text/images/tool traces). This is the genuine "upload docs → knowledge base" capability.
- **Self-hostable / API:** Yes — **REST API server** (uvicorn, ~`:8001`), Docker, MCP support, Python SDK, NPM local plugin (`@memtensor/memos-local-plugin`). Multi-user isolation via **`user_id` + `mem_cube_id`**.
- **Maturity:** larger community (10k stars), enterprise framing, active (mid-2026 release). Still "Preview" per its own README.

### Verdict on identity
"MemoryOS" the **name** = BAI-LAB (conversational memory). The **KB capability** the founder implicitly wants ("базы знаний", upload docs) = MemTensor's **MemOS**. This distinction is the single most important finding — confirm with the founder which one was meant.

---

## 2. RAG-vs-memory fit — does it fit "knowledge bases"?

Our catalog stub is **"Базы знаний"** — the user mental model is *"upload my docs / FAQ / product info, agent answers from them"* = classic **RAG**: chunk → embed → vector store → retrieve-by-query → stuff into context.

| Need | BAI-LAB MemoryOS | MemTensor MemOS | Plain pgvector RAG (ours) |
|---|---|---|---|
| Upload documents/PDF/URL as KB | **No** (conversation pairs only) | **Yes** (docs + URLs) | Yes (we build chunk+embed) |
| Chunking + vector retrieval | partial (vectors are over dialogue) | Yes | Yes |
| Conversational long-term memory + user profile | **Yes (its whole point)** | Yes | No (would build) |
| Per-(agent,hirer) isolation primitive | `user_id` path | `user_id`+`mem_cube_id` | our `(agent_id, scope_tg_user_id)` columns |
| Self-host effort | Python+Chroma+LLM | server+Docker+LLM | reuses our Postgres |

**Honest conclusion:**
- If "Базы знаний" means **upload docs/FAQ** → **BAI-LAB MemoryOS does NOT do it.** You'd need MemTensor/MemOS, or pair MemoryOS with a separate vector store, or build our own pgvector RAG.
- A true KB needs: **(1)** a chunker, **(2)** an embedder, **(3)** a vector store, **(4)** retrieval, **(5)** per-tenant scoping. BAI-LAB MemoryOS provides 2–4 but only over conversation, not files; MemTensor MemOS provides all five for documents.
- BAI-LAB MemoryOS *shines* for the **other** unbuilt thing the agents need — **per-hirer conversational long-term memory + user profile** (canon §11, our `agent_memory` namespace). That is arguably more on-strategy ("ЦА = AI-агенты, приоритет память→…") than a docs KB.

---

## 3. Integration with Hermes

- **Not a built-in provider.** Hermes' `memory.provider:` accepts only its 9 providers (mem0/Honcho/Supermemory/Hindsight/OpenViking/RetainDB/ByteRover/Holographic/Memori). MemoryOS/MemOS is not one. (Verified in `docs/superpowers/specs/2026-06-24-hermes-memory-isolation.md`.) So we **do not** wire it through Hermes' memory config.
- **Run it as a separate service** that our **agent-worker** (and/or Hermes via a custom **tool/MCP**) calls:
  1. **Agent-worker path (recommended, matches our control model):** agent-worker calls the MemoryOS/MemOS HTTP service to `retrieve` relevant KB/memory for `(agent_id, hirer)`, injects the result into the prompt before the Hermes/gateway call, and `add`s after. Scope is wired server-side from `runId` → identical to our existing `agent_memory` pattern. The LLM never touches the scope key.
  2. **MCP-tool path (only if we want the agent to self-query):** expose MemoryOS-MCP / MemOS-MCP as a tool to Hermes. **Risk:** the agent then supplies arguments → it could pass a different `user_id`/`mem_cube_id` and read another tenant. This is the exact OWASP LLM06 / Hermes #34352 "memory ops bypass hooks" failure mode. **Do not expose raw scope to the LLM** — if we use MCP, the scope must be injected by a server-side proxy that overwrites `user_id`, not passed by the model.
- **Scoping key mapping to our model:**
  - Our boundary key = **`(agent_id, hirer_tg_user_id)`**, wired by the worker from `runId`/session (SECURITY.md).
  - MemoryOS `user_id` ← set to a stable composite e.g. `a{agent_id}_h{hirer_tg_user_id}` (and `ASSISTANT_ID` = `agent_id`). MemOS adds `mem_cube_id` ← per-agent KB cube; `user_id` ← hirer.
  - With Hermes v0.17, `X-Hermes-Session-Key` can carry a stable per-hirer scope, but per our Hermes research **storage-layer enforcement is still missing** → don't rely on it as the boundary. Our worker remains the enforcer.

---

## 4. Recommended integration design for US (honest about effort)

### Decision gate (ask founder)
**"Базы знаний" = (A) upload docs/FAQ KB, or (B) per-hirer conversational long-term memory?** They are different products and pick a different tool. The label "Базы знаний" reads like (A).

### If (A) document KB — recommended: **our own pgvector RAG** (not MemoryOS)
Rationale: it reuses Postgres (already our source-of-record), keeps isolation in code we own, and avoids standing up + securing a third-party multi-tenant memory server. MemTensor/MemOS is the off-the-shelf alternative but adds a service to operate and still needs our isolation proxy.
- **Thin MVP (build, ~3–5 dev-days):**
  - Table `agent_kb_docs(agent_id, scope_tg_user_id, doc_id, title, source, created_at)` + `agent_kb_chunks(... , chunk, embedding vector(1024))` with index `(agent_id, COALESCE(scope_tg_user_id,0))`. (Same isolation shape as `agent_memory`.)
  - Ingest: accept text/markdown/URL → chunk (~500–800 tok) → embed via our gateway's embedding model (`:4000`, white-label, billed) → insert. **Scope written by worker, not request.**
  - Retrieve: in agent-worker `resolveUpstream`/pre-prompt step, `SELECT … ORDER BY embedding <=> :q LIMIT k WHERE agent_id=:a AND scope=:scope` → inject top-k into context. Reuses the existing inject-before-gateway pattern.
  - UI: turn the `◷ фаза 3` "Базы знаний" stub into a real "upload / paste / add URL" panel scoped to the agent; show doc list. One amber CTA.
- **Full:** PDF/file parsing, dedup, re-embed on model change, citations in run-trace, per-doc delete, size caps, multimodal.
- **Effort honesty:** pgvector extension on the managed Postgres must be enabled (**SPIKE** — confirm Timeweb managed PG supports `vector`); embedding cost flows through gateway markup; file parsing (PDF) is the long pole.

### If (A) and we prefer off-the-shelf: **MemTensor/MemOS as a sidecar service**
- Run MemOS REST server (Docker, `:8001`) on the Hermes-capable VPS (4–8GB box, the 2GB prod box can't host it).
- agent-worker calls `add`/`search` with `user_id = hirer`, `mem_cube_id = agent`. **Wrap in our proxy** so the LLM never sets scope.
- **Effort:** ~5–8 dev-days incl. ops/security hardening; adds a service to deploy + monitor; isolation still needs our proxy (don't trust their `user_id` as a security boundary without a SPIKE test of cross-tenant read).

### If (B) conversational long-term memory: **BAI-LAB MemoryOS (or mem0) behind our worker**
- Self-host `memoryos-pro` (or use mem0, which Hermes already supports and which has cleaner `user_id` namespacing).
- agent-worker calls `add_memory(user_input, agent_response)` post-turn with `user_id = a{agent}_h{hirer}`, and `retrieve_memory(query)` pre-turn. Inject into context. **Our Postgres mirrors writes as source-of-record** (so a vendor leak/bug can't become our boundary failure).
- **Effort:** MVP ~3–4 dev-days; the heavy part is the **isolation SPIKE** (prove two hirers can't read each other) + standing up Chroma + an embedder.

### Reuse existing blocks
- Isolation shape: copy `agent_memory (agent_id, scope_tg_user_id)` + the "scope wired from runId" rule verbatim (SECURITY.md, ARCHITECTURE.md).
- Injection point: the same pre-gateway context-assembly step the worker already has.
- Embeddings + LLM: route through our **`:4000` gateway** (white-label + billed via markup) — don't let MemoryOS call OpenAI directly (margin leak + brand leak).
- Billing: KB ingest/embeddings = AIAG-supplied model → debit + markup (commission rule); BYOK stays free.

---

## 5. Isolation (OWASP LLM06) — non-negotiable

- **The scope key is wired server-side from `runId`/session, NEVER from the request body or the LLM.** This is the single rule that makes any of the above safe. (SECURITY.md "Memory isolation per-hirer".)
- Index every KB/memory row by **`(agent_id, COALESCE(scope_tg_user_id,0), key)`**; every retrieval filters on it.
- If MemoryOS/MemOS is exposed as an MCP **tool**, a server-side **proxy must overwrite `user_id`/`mem_cube_id`** with the worker-derived scope before forwarding — the model's arguments for scope are ignored. Otherwise the agent can request another tenant's namespace (Hermes #34352 / #4726 class of bug; MemoryOS' own `user_id` is convention, not enforced).
- **Public-template sharing:** a template's KB must publish **spec/structure only**, never the hirer's memory/docs (matches the canon "public spec, private keys/memory/data" rule). Per-hirer KB scope = `scope_tg_user_id`; the creator's KB (if shared read-only) = `scope_tg_user_id = 0`/`creator`, and a hirer **never** writes into it.
- **SPIKE before trusting any vendor isolation:** two hirers on one instance, attempt cross-read. Until passed, treat the vendor store as a cache and keep our Postgres as the boundary.

---

## 6. Alternatives + forward questions

### Alternatives (some already Hermes-native)
- **mem0** — Hermes built-in provider, first-class `user_id` namespacing, OSS self-host (Qdrant + our embedder). **Lowest-friction conversational memory** because Hermes already speaks it. Docs: <https://docs.mem0.ai/integrations/hermes>.
- **Honcho** — strongest multi-user peer model (Hermes built-in). Good if we lean into many hirers per agent. (Watch 100-char session-id limit, #13868.)
- **Supermemory** — container-tag scoping; markets itself as memory **+** doc ingestion → a contender if we want one tool for both KB and memory. (Hermes built-in.)
- **MemTensor/MemOS** — best off-the-shelf **document KB** with isolation/sharing; not Hermes-native (sidecar).
- **Plain pgvector** — most control, reuses our stack, we own isolation; more code.

### Is MemoryOS actually better for us?
- For a **docs KB** (the literal "Базы знаний"): **No — BAI-LAB MemoryOS is the wrong category.** Prefer pgvector (control) or MemTensor/MemOS / Supermemory (off-the-shelf KB).
- For **conversational long-term memory**: BAI-LAB MemoryOS is a strong *algorithm* (good LoCoMo numbers), but **mem0 wins on integration** because Hermes supports it natively and it namespaces by `user_id` out of the box. Choose MemoryOS only if its hierarchical-profile quality is worth running a non-native service.

### Open questions (top, for the founder/SPIKE)
1. **Which "Базы знаний" do we mean — upload-docs KB (A) or per-hirer conversational memory (B)?** Picks the tool. (A) ⇒ pgvector/MemOS/Supermemory; (B) ⇒ mem0/MemoryOS.
2. **Did the founder mean BAI-LAB "MemoryOS" specifically, or MemTensor "MemOS" (the KB one)?** The names collide; the capabilities differ. Confirm.
3. **Does Timeweb managed Postgres support the `pgvector` extension?** Gate for the cheapest (own-RAG) path. (**SPIKE**)
4. **Where does the memory/KB service run?** The 2GB prod box can't host Chroma/MemOS+embedder; needs the 4–8GB Hermes box. Own-pgvector avoids a new service entirely.
5. **Cross-tenant isolation SPIKE** on whichever vendor: prove hirer A cannot read hirer B's namespace before it backs a paid feature.

---

## Sources (all consulted)
- BAI-LAB MemoryOS repo: <https://github.com/BAI-LAB/MemoryOS> · README <https://github.com/BAI-LAB/MemoryOS/blob/main/README.md>
- MemoryOS paper (EMNLP 2025 Oral): <https://arxiv.org/abs/2506.06326> · <https://arxiv.org/html/2506.06326v1>
- MemoryOS-MCP: <https://pypi.org/project/memoryos-mcp/> · <https://www.piwheels.org/project/memoryos-mcp/>
- MemTensor MemOS repo: <https://github.com/MemTensor/MemOS> · papers <https://arxiv.org/abs/2507.03724>, <https://arxiv.org/abs/2505.22101>
- PyPI `MemoryOS` (resolves to MemOS feature copy — name collision): <https://pypi.org/project/MemoryOS/>
- mem0 ↔ Hermes: <https://docs.mem0.ai/integrations/hermes>
- Our Hermes memory + isolation research: `docs/superpowers/specs/2026-06-24-hermes-memory-isolation.md`
- Our isolation rules: `SECURITY.md`, `docs/ARCHITECTURE.md`, canon §11
- Provider comparison: <https://www.glukhov.org/ai-systems/memory/agent-memory-providers/>
- EmergentMind topic page: <https://www.emergentmind.com/topics/memoryos>
