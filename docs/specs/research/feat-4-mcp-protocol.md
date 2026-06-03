# feat-4 — Connecting the agent runtime to a user-supplied MCP server

> Implementation-ready research notes. Scope: let an AIAG agent call tools hosted on a **user-provided remote MCP server** from inside the existing stateless BullMQ worker (`apps/agent-worker/src/agent-runner.ts`). Grounded in the live code: `tools.ts` (`ToolDef`/`executeTool`), `safe-fetch.ts` (SSRF guard), `agent-runner.ts` (the OpenAI-style tool loop).
>
> Constraints that shape every decision: **2GB VPS, no per-user processes, money path is live, white-label, SSRF is a real threat (R1-7/D-7).**

---

## 0. TL;DR for the impatient

- **Transport:** Streamable HTTP only. Never stdio (stdio = spawn a subprocess per user → forbidden on the 2GB VPS).
- **Client:** `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`. ~3 calls: `connect()` → `listTools()` → `callTool()`. No persistent connection between runs — connect at run start, close at run end (the worker is stateless by design).
- **Security:** the SDK's transport uses plain `fetch`, which **bypasses our `safeFetch` SSRF guard**. This is the single biggest gotcha. Either inject a `safeFetch`-backed `fetch` via `requestInit`/custom-transport, or pre-validate the URL with `vetUrl` before connecting. Add per-call timeout + tool-count/result-size caps.
- **First slice:** one read-only remote Streamable-HTTP MCP server per agent, tools namespaced `mcp__*`, merged into `pickToolDefs()`, dispatched in `executeTool()`. No auth-flow UI, no OAuth, no resources/prompts/sampling — just a static bearer header the user pastes.

---

## 1. Transports — what fits a hosted multi-user worker

MCP defines two standard transports ([spec 2025-06-18](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)). A third (legacy HTTP+SSE) is deprecated.

| Transport | How it works | Fit for AIAG worker |
|---|---|---|
| **stdio** | Client **spawns the server as a local subprocess**; JSON-RPC over the child's stdin/stdout, newline-delimited. | ❌ **Hard no.** One subprocess **per agent per run** on a 2GB box already running 5 pm2 procs. Violates "no per-user processes" (`/CLAUDE.md`). Also can't run a *user's* server — their code isn't on our host. |
| **Streamable HTTP** (current, spec 2025-03-26) | JSON-RPC 2.0 over **one HTTP endpoint** (e.g. `https://host/mcp`). Client `POST`s requests; server replies with either a single `application/json` body or an **SSE stream** (`text/event-stream`) when it wants to stream/push. Optional `GET` opens a server→client SSE channel. Server is an independent, already-running process that handles many clients. | ✅ **The only viable option.** No process on our side — just outbound HTTPS. The user (or a hosting provider) runs the server; we're a thin client. Multiplexes cleanly across users. |
| HTTP+SSE (legacy, 2024-11-05, two-endpoint) | Old split design: a `GET /sse` channel + a separate `POST` endpoint. **Deprecated** in favour of Streamable HTTP. | ⚠️ Don't build for it. The SDK's `StreamableHTTPClientTransport` can fall back to it for old servers; we treat that as best-effort, not a target. |

**Decision: Streamable HTTP, full stop.** It maps onto the worker's existing model — a stateless loop that makes outbound HTTPS calls (exactly like the `:4000` gateway and Kie calls already do).

**Note on "streaming":** our tool loop is request/response (we `await` a full tool result before feeding it back to the model — see `agent-runner.ts` line ~559). We don't need SSE streaming semantics; Streamable HTTP works fine in plain request/response mode (server returns a single JSON body). SSE only matters if a tool emits progress notifications, which the first slice ignores.

---

## 2. Minimal client flow + mapping into the OpenAI-style loop

### 2.1 Dependency

```
bun add @modelcontextprotocol/sdk   # in apps/agent-worker
```
Both `Client` and `StreamableHTTPClientTransport` ship from this one package
(`@modelcontextprotocol/sdk/client/index.js` and `.../client/streamableHttp.js`).
The worker is tsc-compiled Node (ESM) — the SDK is ESM-native, so imports use `.js` specifiers like the rest of the worker.

### 2.2 The lifecycle (what `client.connect()` does under the hood)

Per the [lifecycle spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle), connect performs the handshake for us:

1. **`initialize` request** — client sends `protocolVersion`, `capabilities`, `clientInfo {name, version}`.
2. **`initialize` response** — server returns its `protocolVersion` (must match or be negotiated down), `capabilities` (we care about `tools`), `serverInfo`.
3. **`notifications/initialized`** — client confirms it's ready.

The SDK handles all three plus version negotiation. After init, on HTTP the SDK also auto-attaches the `MCP-Protocol-Version` header to every subsequent request. We never hand-roll JSON-RPC.

### 2.3 The three calls we actually use

```ts
// apps/agent-worker/src/mcp-client.ts  (new file)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface McpEndpoint {
  url: string;            // user-supplied https URL, e.g. https://mcp.example.com/mcp
  authHeader?: string;    // decrypted "Authorization: Bearer ..." value, optional
}

export async function openMcp(ep: McpEndpoint): Promise<Client> {
  // SSRF GATE — see §3. Validate BEFORE the SDK touches the network.
  await assertSafeMcpUrl(ep.url);

  const transport = new StreamableHTTPClientTransport(new URL(ep.url), {
    requestInit: {
      headers: ep.authHeader ? { Authorization: ep.authHeader } : {},
    },
    // NOTE: requestInit options are passed to the SDK's fetch. See §3 for the
    // safeFetch problem — headers/timeout here are necessary but NOT sufficient.
  });

  const client = new Client(
    { name: 'aiag-agent-worker', version: '1.0.0' },
    { capabilities: {} }, // we expose no client features (no roots/sampling/elicitation)
  );
  await client.connect(transport); // does initialize + initialized
  return client;
}
```

```ts
// list tools (once, right after connect)
const { tools } = await client.listTools();
//  tools: Array<{ name, description?, inputSchema: JSONSchema }>

// call one tool
const res = await client.callTool({
  name: 'get_weather',
  arguments: { city: 'Moscow' },
});
//  res: { content: Array<{type:'text', text:string} | {type:'image',...} | ...>,
//         isError?: boolean, structuredContent?: unknown }
```

### 2.4 Mapping MCP tools → our `ToolDef` (OpenAI function-calling)

Our loop already speaks OpenAI function-calling (`tools.ts` `ToolDef`, `agent-runner.ts` builds `body.tools`/`tool_choice:'auto'` and dispatches `executeTool(name, args, ctx)`). MCP's tool shape maps **1:1**:

| MCP `tool` field | OpenAI `ToolDef.function` field |
|---|---|
| `name` | `name` (we **prefix** it — see below) |
| `description` | `description` |
| `inputSchema` (JSON Schema) | `parameters` (already JSON Schema — pass through) |

**Namespacing (critical):** prefix MCP tool names so they never collide with the 4 built-ins (`web_search`, `calc`, `image_gen`, `memory`) and so the dispatcher knows where to route. Convention: `mcp__<toolname>` (mirrors how Claude Code namespaces MCP tools). On dispatch, strip the prefix before calling `client.callTool`.

```ts
// build ToolDefs from a live MCP session
export function mcpToolDefs(tools: McpTool[]): ToolDef[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: `mcp__${t.name}`,
      description: t.description ?? '',
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }));
}
```

**Result mapping:** MCP returns `content: [{type:'text', text}, ...]`. The model wants a string/JSON for the `tool` message. Flatten text parts to a string (drop or summarize binary/image parts for the first slice), honour `isError`:

```ts
function flattenMcpResult(res: CallToolResult): unknown {
  if (res.isError) return { error: textOf(res) };
  return { result: textOf(res), structured: res.structuredContent };
}
function textOf(res: CallToolResult): string {
  return (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n')
    .slice(0, 8000); // matches the existing 8000-char tool-result cap in agent-runner
}
```

### 2.5 Where it slots into the run loop

`agent-runner.ts` today: `pickToolDefs(agent.tools)` → loop → on a tool call, `executeTool(name, args, {agentId})`. The MCP integration is additive:

1. **Run start (once):** if `agent.mcp_endpoint` is set, `const mcp = await openMcp(ep)`, `const remote = await mcp.listTools()`, `const remoteDefs = mcpToolDefs(remote.tools)`.
2. **Tool list:** `const tools = [...pickToolDefs(agent.tools), ...remoteDefs];` — built-ins + remote, all in one OpenAI `tools` array.
3. **Dispatch:** in the `for (const toolCall of toolCalls)` block, branch:
   ```ts
   const name = toolCall.function.name;
   const exec = name.startsWith('mcp__')
     ? await callMcpTool(mcp, name.slice(5), parsed) // → { result, cost_rub }
     : await executeTool(name, parsed, { agentId: agent.id });
   ```
   `callMcpTool` wraps `client.callTool` + `flattenMcpResult` and returns the same `{ result, cost_rub }` shape `executeTool` returns, so the existing accounting/`toolFeesRub`/`messages.push({role:'tool', ...})` code is untouched.
4. **Run end:** `await mcp.close()` (or `transport.close()`), in a `finally`, so the stateless worker leaves no dangling connection. **No connection reuse across runs** — that's the whole point of the stateless design; a fresh `connect` per run is cheap (one HTTPS round-trip) and keeps zero per-user state on our box.

**Billing:** MCP tool calls hit the *user's* server, not an AIAG-supplied model, so by the commission rule they're **not** a model debit. Set `cost_rub: 0` for the first slice (we charge nothing for proxying a call to the user's own MCP). If/when we add paid tools, surface a fee via the same `toolFeesRub` channel — but that's out of scope here.

---

## 3. Security for a hosted setting (the load-bearing section)

The agent calls a **user-provided HTTPS endpoint**. This is the exact SSRF threat model `safe-fetch.ts` was written for (D-7 / R1-7): a user could point `mcp_endpoint` at `http://169.254.169.254/...` (cloud metadata), `127.0.0.1:4000` (our internal gateway), Postgres/Redis, or any RFC1918 host — via DNS rebinding, an integer-encoded literal, or a 302 redirect from a public host to an internal one.

### 3.1 The SDK does NOT use our safeFetch — this is the trap

`StreamableHTTPClientTransport` calls the global `fetch`. That means **none** of the `safeFetch` protections (HTTPS-only, IP-range blocklist, DNS-resolve-all-and-reject, socket pinning anti-rebind, per-hop redirect re-validation) apply automatically. Two ways to fix, in order of preference:

**Option A — pre-flight URL validation (smallest, ship this first).**
Export `vetUrl` (currently private in `safe-fetch.ts`) or add a thin `assertSafeMcpUrl(url)` that reuses its checks, and call it **before** `client.connect()`:

```ts
// reuses safe-fetch.ts internals (vetUrl: rejects non-https, IP literals in
// blocked ranges, hosts that DNS-resolve into blocked ranges, numeric literals)
export async function assertSafeMcpUrl(raw: string): Promise<void> {
  await vetUrl(raw, new Set()); // empty allowlist → no internal host may pass
  // throws SsrfError on violation
}
```
Gap: this validates the *initial* URL but not a runtime **redirect** the SDK's fetch might follow to an internal host, and it has a TOCTOU window vs. DNS rebinding (resolve-then-connect race). Acceptable for a v1 read-only slice; **must** be closed in v2.

**Option B — inject a safeFetch-backed fetch (the real fix).**
Pass a custom `fetch` into the transport so *every* hop (initial + redirects + each `callTool` POST) goes through `safeFetch` (which pins the socket to the validated IP = anti-rebind, and re-validates each redirect):

```ts
const safe = (input: any, init: any) =>
  safeFetch(input, { ...init, allowlist: [] }); // [] = no internal host allowed
const transport = new StreamableHTTPClientTransport(new URL(url), {
  fetch: safe as typeof fetch,            // SDK accepts a custom fetch
  requestInit: { headers: { Authorization: authHeader } },
});
```
This is the correct end state because it closes the redirect + rebinding gap for the *whole* session, not just the handshake. Verify the installed SDK version accepts a `fetch` override (recent `@modelcontextprotocol/sdk` does); if not, fall back to Option A + disallow redirects.

**Allowlist MUST be empty `[]` for user MCP URLs.** The worker's existing `SAFE_FETCH_ALLOWLIST = ['127.0.0.1:4000','openrouter.ai']` is for *our* trusted upstreams; a user MCP endpoint gets **no** allowlist, so `127.0.0.1:4000` (our gateway) and every private host are blocked.

### 3.2 Auth headers

- Accept a single user-supplied header value (typically `Authorization: Bearer <token>` or an `X-Api-Key`). Store **encrypted** the same way BYOK keys are (`AES-256-GCM`, `encryptSecret().toString('base64')`, decrypt at run time with `decryptSecret` — already imported in `agent-runner.ts`). UI shows last 4 chars only (`/SECURITY.md` BYOK rule).
- Inject via `requestInit.headers`. Never log the header value; never echo the MCP URL with credentials.
- **Do NOT implement MCP OAuth** for the first slice. The spec defines an OAuth2 flow for remote servers, but it needs a redirect/consent UI we don't have. Static token only; OAuth is v2.

### 3.3 Timeouts, caps, and the 2GB constraint

- **Per-call timeout:** the SDK's `callTool` accepts a request options `{ timeout }` (ms); set ~15–20s, well under the worker's overall run budget. Spec says clients SHOULD time out and SHOULD issue a cancellation notification — the SDK does this. Also wrap `connect()` in a connect timeout (~10s).
- **Tool-count cap:** clamp `listTools()` to the first ~32 tools so a hostile server can't flood the model's tool list (token blowup → cost). Reject tools whose `inputSchema` is absent/malformed.
- **Result-size cap:** already enforced — `.slice(0, 8000)` on the tool message. Keep it. Also cap total bytes read per `callTool` (SSE streams can be unbounded; a malicious server could stream forever — rely on the per-call timeout + a max-bytes guard).
- **Iteration cap:** the existing `MAX_ITERATIONS = 12` bounds how many tool round-trips a run can make — this already limits MCP-call amplification. No change needed.
- **Memory/CPU:** the SDK client is light (a fetch wrapper + JSON-RPC state machine, low-MB). **No subprocess, no resident pod** — this is what keeps us inside the 2GB envelope. One transient client per active run; closed in `finally`. Do **not** add a connection pool or a long-lived MCP manager (that would reintroduce per-user resident state we explicitly don't want).
- **No prompts/resources/sampling in v1.** `sampling` would let the *MCP server* ask *us* to run an LLM call (server-initiated, billable, white-label-leaking) — **never enable it.** Advertise empty client `capabilities: {}` so the server can't request roots/sampling/elicitation.

### 3.4 Trust posture

The MCP tool *descriptions and results are attacker-controlled text* fed straight into the model (classic tool-poisoning / prompt-injection surface). For a read-only v1 this is acceptable (the agent is the user's own; blast radius is their own balance/run). When write-capable or shared-template MCP servers arrive, add: explicit per-tool allowlisting by the agent owner, and a "this tool came from an external server" marker in the run-trace UI.

---

## 4. Smallest viable first slice

**Goal:** an agent can attach **one** remote Streamable-HTTP MCP server and the model can call its **read-only** tools, billed at 0₽, fully SSRF-guarded.

**Schema (one nullable column set, manual prod migration per `/docs/ARCHITECTURE.md`):**
- `agents.mcp_endpoint_url text null`
- `agents.mcp_auth_encrypted text null` (AES-256-GCM, nullable)
- (optional) `agents.mcp_tool_allowlist text[] null` — defer; v1 exposes all listed tools.

**Code (new `apps/agent-worker/src/mcp-client.ts`):**
1. `assertSafeMcpUrl` (reuse `vetUrl`) — §3.1.
2. `openMcp(ep)` → connected `Client` (custom safeFetch transport — §3.1 Option B, or A as fallback).
3. `listMcpTools(client)` → clamp to 32, map to `ToolDef[]` with `mcp__` prefix.
4. `callMcpTool(client, bareName, args)` → `{ result, cost_rub: 0 }`, timeout 15s, flatten content, slice 8000.

**Wire-in (`agent-runner.ts`, surgical):**
- After `const tools = pickToolDefs(agent.tools);`, if `agent.mcp_endpoint_url`: open client, append `mcpToolDefs`. Keep a `let mcp: Client | null` and `try/finally { await mcp?.close() }` around the run loop.
- In the tool-dispatch loop, branch on `name.startsWith('mcp__')`.

**Explicitly OUT of v1:** stdio, OAuth, multiple MCP servers per agent, MCP resources/prompts/sampling, write tools, paid/metered MCP tools, connection reuse/pooling, the management UI beyond a single URL+token field.

**Verification (no local runtime — `/feedback_no_local_runtime`):** typecheck/build green; deploy to VPS; test against a known public read-only Streamable-HTTP MCP server (e.g. a docs/search server) by creating one agent with `mcp_endpoint_url` set and confirming a run lists + calls a tool. Then attempt an SSRF probe (`mcp_endpoint_url=http://169.254.169.254/...` and a host that resolves to a private IP) and confirm `SsrfError` rejects it before any connect.

---

## 5. MCP integration vs. just finishing the provider-picker — comparison

Both are "connect the worker to a user-supplied external thing." Honest read:

| | **Finish provider-picker** | **MCP integration (this feat)** |
|---|---|---|
| What it unlocks | Where the agent's **model** comes from (AIAG/OpenRouter/BYOK/Gonka/custom). A *necessary, billable* path. | What **tools** the agent can call beyond our 4 built-ins. A *capability expander*, not on the money path. |
| Code reality | **~80% already built.** `resolveUpstream` handles `provider_id` + decrypted creds; migration 0026 applied to prod; `GET /api/providers` live. **Remaining = BYOK write + worker resolveUpstream polish + TMA UI** (per memory `provider_connection_p0`). | **0% built.** New dep, new client module, new schema, new dispatch branch, new SSRF surface. |
| Money-path risk | **High-touch** — it *is* the billing/commission path (`isExternal` short-circuit, settleRun). Mistakes = mischarge/double-spend. | **Low** — read-only, 0₽, off the model-billing path. settleRun untouched. |
| Security surface | Reuses the **same** SSRF/safeFetch + BYOK-encryption machinery already wired in `agent-runner.ts`. | Reuses the same machinery **but** introduces the SDK-doesn't-use-safeFetch trap (§3.1) + tool-poisoning surface (§3.4) that the provider-picker doesn't have. |
| User value now | Direct, on-roadmap (P0). Without it, agents are stuck on AIAG-default models; "own key = free" is half-wired. | Differentiating but **aspirational** — most TMA users want a ready agent in 2 clicks (`PRODUCT.md`), not to wire their own MCP server. Powers the "skills/MCP hub" which `/CLAUDE.md` lists as **R&D/unbuilt**. |
| Effort | **Small + de-risking** — completes started work, closes a coherence gap, makes the commission rule fully real. | **Medium + net-new** — green-field module with a fresh security surface to get right. |

**Recommendation:** finish the provider-picker first. It's mostly done, it's directly on the live money path (completing it *reduces* risk by closing a half-wired billing branch), and it delivers the "own model/key = free" promise that's already in the product copy. MCP is a strong **second** step — it slots cleanly into the same `executeTool` loop and reuses the same encryption + (with care) the same SSRF guard — but it's net-new code with a fresh attack surface, and it serves power users while the provider-picker serves the core flow. Sequence: **provider-picker → MCP read-only v1 → MCP auth/write/OAuth**.

---

## Sources

- [MCP Transports (spec 2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) — stdio vs Streamable HTTP; SSE deprecation.
- [MCP Lifecycle (spec 2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) — initialize / initialized / version negotiation, `MCP-Protocol-Version` header, timeouts.
- [`@modelcontextprotocol/sdk` (npm)](https://www.npmjs.com/package/@modelcontextprotocol/sdk) and [typescript-sdk client docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md) — `Client`, `StreamableHTTPClientTransport`, `requestInit.headers`, `listTools()`, `callTool()`.
- [stdio vs Streamable HTTP — choosing a transport](https://kirkryan.co.uk/stdio-vs-streamable-http-choosing-the-right-mcp-transport/) and [truefoundry: stdio vs Streamable HTTP trade-offs](https://www.truefoundry.com/blog/mcp-stdio-vs-streamable-http-enterprise) — multi-user/hosted guidance.
- Repo: `apps/agent-worker/src/{agent-runner,tools,safe-fetch}.ts`, `/SECURITY.md`, `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, memory `project_provider_connection_p0`.
