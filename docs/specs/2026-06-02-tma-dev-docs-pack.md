# AIAG TMA — DEV DOCS PACK (current library APIs for the R0–R3 fixes)

**Date:** 2026-06-02 · **Pairs with:** `2026-06-02-tma-tech-stack-108-eval.md` (the 50/108 scoring) and
`2026-06-02-tma-tech-remediation-roadmap.md` (R0–R3 waves, files, effort). This pack is the **implementation
reference**: the *current, copy-usable* API for every library the roadmap touches, the gotchas that will bite,
plus the corrections and gaps surfaced by a fresh context7 pass on 2026-06-02.

---

## 1. How to use this doc

- The **eval** says *what's broken and by how much*. The **roadmap** says *what to fix, in what order, in which
  files*. **This doc** says *exactly which API to call to implement each fix*, against the versions context7
  resolved on 2026-06-02 (not training-data recall).
- Each section in §2 maps to one or more **R0–R3** items. Code blocks are paste-ready; treat field names
  (e.g. `inputSchema` not `parameters`, `costDetails` not `usage`) as load-bearing — they changed across major
  versions and are the single biggest source of "the docs I remember are wrong."
- §3 consolidates **every correction** to the prior research. Read it before coding — several roadmap
  assumptions (Vercel AI "v6", `ToolLoopAgent`, `verifyTonProof(proof,address,domain)`, "x-tma-user-id is
  spoofable", `toNano()` for jettons) are factually wrong against the installed/current APIs.
- §4 ranks the **gaps we had NOT researched** by development importance, each with a one-line fix. This is where
  the production must-haves live (Next.js CVE patch, rate limiting, idempotency, migration tracking,
  embeddings, secrets-at-rest, DLQ, backup/DR).
- §5 lists **open spikes** context7 could not close — things requiring a lockfile grep, a VPS check, or an
  architecture decision before code.
- Source library IDs / URLs are preserved inline so you can re-query context7 (`/owner/repo` or
  `/websites/...`) when you hit an edge.

---

## 2. Per-topic implementation reference

### 2.1 MCP gateway + Hono — per-tenant routing, bearer auth, stateless StreamableHTTP
**Serves:** R0-1 (route agent runs through the gateway), R0-4 (verify-then-trust auth), R1/R3 per-agent MCP tool surface.
**Library IDs:** `/modelcontextprotocol/typescript-sdk`, `/websites/hono_dev`

For a **stateless, multi-tenant** MCP gateway the **per-request factory** is canonical: build a fresh
`McpServer` **and** a fresh `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })` on
*every* request, connect them, `transport.handleRequest(c.req.raw, options)`, then close both. There is **no
shared transport** in stateless mode — sessions require keeping a transport alive, which we explicitly do not
want. The transport is Web-Standard (`Request` in / `Promise<Response>` out), so it drops straight into a Hono
handler via `c.req.raw` and you return the `Response` directly.

```ts
// Per-agent factory: NEW server + NEW transport every call. Never cache the transport in stateless mode.
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';

function buildAgentServer(agentId: string, identity: AuthInfo): McpServer {
  const server = new McpServer({ name: `aiag-agent-${agentId}`, version: '1.0.0' });
  server.registerTool('search', { description: '...', inputSchema: { q: z.string() } },
    async ({ q }, extra) => {
      const who = extra.authInfo;            // v1; v2 = ctx.http?.authInfo (SEE gotcha #1)
      return { content: [{ type: 'text', text: `result for ${q}` }] };
    });
  return server;
}
```

```ts
// Hono per-tenant route — fresh transport per request, return Response directly
app.all('/t/:agentId/mcp', authMiddleware, async (c) => {
  const agentId = c.req.param('agentId');
  const identity = c.get('authInfo');        // set by authMiddleware
  const server = buildAgentServer(agentId, identity);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  try {
    // WebStandard: Request in -> Response out. Pass authInfo so tool handlers see it.
    return await transport.handleRequest(c.req.raw, { authInfo: identity });
  } finally {
    await transport.close();                 // MUST close both, or per-request servers leak under BullMQ load
    await server.close();
  }
});
// handleRequest(req: Request, options?: { authInfo?, parsedBody? }): Promise<Response>
// Pass { parsedBody: await c.req.json() } if middleware already consumed the body stream.
```

```ts
// Auth middleware — verify bearer JWT BEFORE the transport (Hono-shaped, NOT Express requireBearerAuth)
import { verify } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';

const authMiddleware = createMiddleware<{ Variables: { authInfo: AuthInfo } }>(async (c, next) => {
  const h = c.req.header('Authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  let payload;
  try { payload = await verify(token, c.env.JWT_SECRET, 'HS256'); }   // pin alg; RS256 -> use hono/jwt jwk()
  catch { return c.json({ error: 'invalid_token' }, 401); }
  c.set('authInfo', { token, clientId: String(payload.sub), scopes: [], extra: payload } as AuthInfo);
  await next();
});
```

```ts
// CORS for browser/cross-origin MCP clients
import { cors } from 'hono/cors';
app.use('*', cors({ allowMethods: ['GET','POST','DELETE','OPTIONS'],
  allowHeaders: ['Content-Type','mcp-session-id','Last-Event-ID','mcp-protocol-version','Authorization'],
  exposeHeaders: ['mcp-session-id','mcp-protocol-version'] }));

// Token streaming on the chat route — streamSSE + writeSSE
import { streamSSE } from 'hono/streaming';
app.post('/t/:agentId/chat', authMiddleware, async (c) => streamSSE(c, async (stream) => {
  let id = 0;
  for await (const chunk of llmTokenStream)
    await stream.writeSSE({ data: JSON.stringify({ delta: chunk }), event: 'token', id: String(id++) });
  await stream.writeSSE({ data: '[DONE]', event: 'done', id: String(id++) });
}));
```

**Gotchas**
1. **SDK version split (check the lockfile FIRST).** Tool-handler context is mid-migration. v1 = `(args, extra) => { extra.authInfo, extra.requestInfo?.headers }`; v2 renames the param to `ctx` and nests it: `ctx.http?.authInfo`, `ctx.http?.req`, `ctx.mcpReq.signal/id`. Guessing wrong silently yields `undefined` identity.
2. **Stateless = NO shared transport.** The `createMcpHonoApp` single-endpoint example wires ONE long-lived transport+server — fine for one global server, WRONG for `/t/:agentId` (it would share tools/state across agents). Build per request.
3. **Always close both** in a `finally`. The Express stateless example uses `res.on('close')`; the WebStandard/Hono path has no `res`, so use `try/finally` around the returned `Response` promise.
4. **`authInfo` must be passed explicitly.** The WebStandard transport does NOT parse `Authorization` itself. Skip `{ authInfo }` in `handleRequest` and tool handlers get `extra.authInfo === undefined` even after middleware verified the token.
5. **`requireBearerAuth` is Express-shaped** (req/res/next) and won't run in a Hono Web-Standard pipeline. Do auth in Hono middleware and bridge to the SDK's `AuthInfo` shape (`{ token, clientId, scopes, expiresAt?, extra }`) yourself.
6. **If middleware reads the body** (e.g. to inspect the JSON-RPC method for routing/billing) you consume the stream — pass it back as `{ parsedBody }` or the transport gets a locked/empty body.
7. **DNS-rebinding protection:** `handleRequest` runs `validateRequestHeaders` first and can short-circuit on Host/Origin before tools run. Behind the `:4000` gateway / reverse proxy, configure `allowedHosts`/`allowedOrigins` on the transport or requests get rejected.
8. **`hono/jwt verify()` is HS256 (shared secret).** RS256/asymmetric → use the `jwk()` middleware with `jwks_uri` instead.

Sources: context7 `/modelcontextprotocol/typescript-sdk` — `packages/middleware/hono/README.md`, `examples/server/src/honoWebStandardStreamableHttp.ts`, `examples/server/src/simpleStatelessStreamableHttp.ts`, `packages/server/src/server/streamableHttp.ts`, `docs/migration.md`+`docs/migration-SKILL.md`; `/websites/hono_dev` — `docs/middleware/builtin/jwt`, `docs/helpers/jwt`, `docs/helpers/streaming`, `docs/api/context`, `docs/guides/middleware`, `docs/middleware/builtin/jwk`.

---

### 2.2 Agent runtime — Vercel AI SDK + Mastra over the existing BullMQ tool-loop
**Serves:** R0-1/R0-6 (gateway routing & provider resolution in the loop), R3 (agent runtime + memory), TMA streaming chat surface.
**Library IDs:** `/websites/ai-sdk_dev` (stable v5), `/websites/ai-sdk_dev_v7` (next/prerelease), `/mastra-ai/mastra`

The existing `apps/agent-worker/src/agent-runner.ts` is a hand-rolled OpenAI-compatible chat-completions loop:
raw `fetch` to OpenRouter/external `baseURL`, `MAX_ITERATIONS=12`, manual `tool_calls` dispatch
(`apps/agent-worker/src/tools.ts`), manual token/cost accounting, zero AI-SDK deps. The Vercel AI SDK maps onto
this almost 1:1.

```ts
// Version reality: as of 2026-06-02 npm 'ai' latest STABLE is v5.x. There is NO v6 on npm.
// Renamed APIs (isStepCount) live ONLY in the v7/next prerelease docs. Pin "ai": "^5" and use stepCountIs.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
const gateway = createOpenAICompatible({
  name: 'aiag-gateway',
  baseURL: 'http://127.0.0.1:4000/v1',     // our Hono gateway; SDK appends /chat/completions
  apiKey: perRequestJwt,                    // bearer; or use headers for per-run JWT
  headers: { 'HTTP-Referer': 'https://ai-aggregator.ru', 'X-Title': 'AIAG TMA' },
});
const model = gateway('nousresearch/hermes-4-405b');
// External user endpoint: baseURL = agent.external_base_url, apiKey = decryptSecret(...).
```

```ts
// Replace the 12-iteration loop with generateText + stopWhen
import { generateText, tool, stepCountIs } from 'ai';   // v5 helper name
import { z } from 'zod';
const { text, steps, usage } = await generateText({
  model,
  system: buildSystem(agent),
  messages,                                  // same role/content shape you already build
  stopWhen: stepCountIs(12),                 // == MAX_ITERATIONS; array allowed: [stepCountIs(12), hasToolCall('final')]
  tools: {
    web_search: tool({ description: '...', inputSchema: z.object({ query: z.string() }), execute: async ({query}) => webSearch(query) }),
    calc:       tool({ description: '...', inputSchema: z.object({ expr: z.string() }),  execute: async ({expr}) => calc(expr) }),
  },
  onStepFinish: async ({ usage, toolCalls, toolResults }) => {
    // accumulate usage.inputTokens/outputTokens -> mid-run budget check; throw to abort (mirrors agent-runner.ts:233-242)
    // NOTE: AUTHORITATIVE debit stays at the :4000 gateway. This is for estimation/cutoff only.
  },
});
// v5 renames: tool 'parameters' -> 'inputSchema'; usage.prompt_tokens/completion_tokens -> usage.inputTokens/outputTokens.
```

```ts
// The Agent primitive — closest to the roadmap's 'ToolLoopAgent' (the symbol is just 'Agent')
import { Agent, stepCountIs } from 'ai';
const agent = new Agent({
  model, system: row.system_prompt, tools, stopWhen: stepCountIs(12),
  prepareStep: async ({ stepNumber, steps }) => {           // runs BEFORE each step
    if (overBudget()) return { stopWhen: stepCountIs(stepNumber) };  // force stop mid-run
    return {};                                              // or { model, system, toolChoice, activeTools } overrides
  },
});
const { text, steps } = await agent.generate({ prompt: run.input });   // .stream({prompt}) for streaming
```

```tsx
// Client streaming with useChat over our gateway (Next 14, react 18)
'use client';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({ api: '/tg/api/chat', headers: { Authorization: `Bearer ${tmaJwt}` }, credentials: 'include' }),
});
// v5: messages are UIMessage[] with .parts (text/tool-invocation), NOT a flat .content string.
// useChat NO LONGER exposes input/handleInputChange/handleSubmit — you own input state. This is a UI rewrite.
// Server route returns result.toUIMessageStreamResponse() from streamText.
```

```ts
// Mastra as a LIBRARY (Apache-2.0 core; only the ee/ dir is commercial). No Mastra class, no CLI, no deployer.
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { PostgresStore, PgVector } from '@mastra/pg';
import { MCPClient } from '@mastra/mcp';
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });   // reuse ONE pool
const memory = new Memory({
  storage: new PostgresStore({ id: 'aiag-store', pool }),   // pass pool, not connectionString, to share
  vector:  new PgVector({ id: 'aiag-vec', connectionString: process.env.DATABASE_URL }),
  options: { lastMessages: 10, semanticRecall: { topK: 3, messageRange: 2 } },
});
const mcp = new MCPClient({ servers: { aiagTools: { url: new URL('http://127.0.0.1:4100/mcp') } }, timeout: 30000 });
const mAgent = new Agent({ id: 'pg-agent', name: 'PG Agent', instructions: row.system_prompt,
  model: gateway('hermes-4-405b'), memory, tools: await mcp.listTools() });
// NEVER import { Mastra } / @mastra/deployer-* / @mastra/server — those bring the Hono dev server + CLI and hijack the Bun process.
```

**Recommendation (lowest churn):** adopt AI SDK `generateText`+`tools`+`stopWhen` for the loop and `useChat`
for the new TMA streaming chat; keep the worker's existing loop initially (it already does what
`stopWhen`+`onStepFinish` do, with full mid-run budget control). Pull in Mastra **selectively** — only
`MCPClient` (per-agent MCP gateway) and managed semantic-recall `Memory` — not the whole framework.

**Gotchas**
- **No `ai` v6 on npm** (2026-06-02). Stable = v5.x (`stepCountIs`); `isStepCount` is v7/next-only. There is **no `ToolLoopAgent` symbol** — using that name fails the import.
- **v5 field renames:** tool `parameters`→`inputSchema`; usage `prompt_tokens`/`completion_tokens`→`inputTokens`/`outputTokens`. Migrating `tools.ts` means rewriting each `ToolDef` as `tool({ inputSchema: z.object(...) })` — raw JSON-Schema won't be accepted as-is.
- **`useChat` v5 is a UI rewrite:** no `input`/`handleSubmit`, no flat `message.content`; read `message.parts[]`.
- **`@mastra/pg` uses node-postgres (`pg`)**, the stack uses raw postgres-js (`postgres ^3.4.5`). Mastra memory adds a SECOND driver+pool unless you wrap it — or keep memory in your own pgvector tables and skip `@mastra/pg`.
- **Mastra Memory auto-creates tables** (`mastra_messages`, `mastra_threads`, vector tables) on first init. On prod (app user `aiag` can't `ALTER`) this fails / needs manual migration — pre-create under a dedicated `schemaName`, don't let it run DDL unsupervised.
- **`createOpenAICompatible` appends `/chat/completions`.** Feed only the base (`…/v1`), not the full completions URL; keep the `agent-runner.ts:38-40` normalization.
- **Billing stays at the gateway.** AI SDK runs the loop client-of-gateway; usage it reports is for estimation. Authoritative atomic debit must happen server-side at `:4000` per request, or multi-step runs under/over-bill.
- **`fastembed`** (Mastra's default embedder) downloads an ONNX model and runs in-process — heavy under Bun. Prefer an AI-SDK embedding model via the gateway so embeddings route through billing.

Sources: context7 `/websites/ai-sdk_dev` (v5: `useChat`+`DefaultChatTransport`, `stepCountIs`, `createOpenAICompatible`), `/websites/ai-sdk_dev_v7` (v7 prerelease: `isStepCount`, `Agent`), `/mastra-ai/mastra` (Agent+Memory+PostgresStore/PgVector with existing pool, `MCPClient.listTools`, programmatic Workflow). Local: `apps/agent-worker/src/agent-runner.ts`, `apps/agent-worker/src/tools.ts`, `apps/agent-worker/package.json`, `apps/tg-miniapp/package.json` (Next 14.2.15, react 18.3.1).

---

### 2.3 Billing / data primitives — postgres-js atomic deduct + BullMQ + pgvector
**Serves:** R0-2/R0-3 (atomic balance + daily-spend), R1 (queue bounding, rate-limit, reconciler idempotency), R3-4 (pgvector memory).
**Library IDs:** `/porsager/postgres`, `/taskforcesh/bullmq`, `/pgvector/pgvector`

```ts
// Atomic guarded deduct — no race, no overdraft. Guard lives IN the WHERE clause.
const debited = await sql`
  UPDATE tg_users SET balance_rub = balance_rub - ${costRub}
  WHERE tg_user_id = ${tgUserId}::bigint AND balance_rub >= ${costRub}
  RETURNING balance_rub::text AS balance_rub` as unknown as Array<{balance_rub:string}>;
if (debited.length === 0) throw new InsufficientFundsError();   // zero rows = 402, NEVER read-then-write
```

```ts
// Transaction: deduct + write run row atomically. SERIALIZABLE for the money path.
const run = await sql.begin('ISOLATION LEVEL SERIALIZABLE', async (sql) => {  // callback-scoped sql ONLY
  const [debited] = await sql`UPDATE tg_users SET balance_rub = balance_rub - ${costRub}
    WHERE tg_user_id = ${tgUserId}::bigint AND balance_rub >= ${costRub} RETURNING balance_rub::text`;
  if (!debited) throw new Error('insufficient_funds');         // auto-ROLLBACK on throw
  const [r] = await sql`INSERT INTO agent_runs (agent_id, tg_user_id, input, status, cost_rub)
    VALUES (${agentId}::uuid, ${tgUserId}::bigint, ${input}, 'queued', ${costRub}) RETURNING id::text`;
  return r;
});
```

```ts
// Shared postgres-js SINGLETON (fix the pool-per-route anti-pattern). postgres() IS a pool.
// apps/tg-miniapp/src/lib/db.ts
import postgres from 'postgres';
export const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 10, idle_timeout: 20, connect_timeout: 10 });
// every route: import { sql } from '@/lib/db';   (do NOT re-instantiate)
// prepare:false is MANDATORY under PgBouncer transaction-pooling. apps/agent-worker/src/db.ts is the correct template.
```

```ts
// BullMQ idempotency — deterministic jobId (a same-id add is dropped while the prior job still exists)
await agentRunQueue.add('agent-run', { runId, agentId, tgUserId },
  { jobId: `run:${runId}`, removeOnComplete: { age: 3600 }, removeOnFail: { age: 86400 } });
// OR time-windowed dedup (independent of job lifecycle), for bursty triggers:
await queue.add('catalog-sync', {}, { deduplication: { id: 'catalog-sync', ttl: 90000 } });

// Bound the queue before enqueue (backpressure -> 429)
const waiting = await agentRunQueue.getWaitingCount();
if (waiting > MAX_QUEUE_DEPTH) return new Response('queue_full', { status: 429 });

// Worker-level rate limit (throttle upstream) + concurrency. Per-GROUP limiting is BullMQ PRO only.
const worker = new Worker('agent-run', processor, { connection, concurrency: 5, limiter: { max: 100, duration: 60000 } });

// Repeatable jobs — upsertJobScheduler (replaces deprecated repeat). Idempotent by id, safe to call every boot.
await topupQueue.upsertJobScheduler('topup-reconciler', { pattern: '*/2 * * * *' }, { name: 'reconcile-topups', data: {} });
await catalogQueue.upsertJobScheduler('catalog-sync', { pattern: '0 * * * *' }, { name: 'sync-catalog', data: {} });
```

```sql
-- pgvector: enable + memory table + HNSW cosine index (CREATE EXTENSION needs superuser: sudo -u postgres psql aiag)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE agent_memory_vec (
  id bigserial PRIMARY KEY, agent_id uuid NOT NULL, content text NOT NULL,
  embedding vector(1536) NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX agent_memory_vec_hnsw ON agent_memory_vec USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);                 -- HNSW > IVFFlat for write-as-you-go (no training)
CREATE INDEX ON agent_memory_vec (agent_id);            -- pre-filter
```

```ts
// pgvector insert + cosine similarity via postgres-js (vector as text literal '[...]'; <=> is distance, smaller=closer)
const vec = JSON.stringify(embedding);
await sql`INSERT INTO agent_memory_vec (agent_id, content, embedding) VALUES (${agentId}::uuid, ${content}, ${vec}::vector)`;
const hits = await sql`SELECT content, 1 - (embedding <=> ${vec}::vector) AS similarity
  FROM agent_memory_vec WHERE agent_id = ${agentId}::uuid
  ORDER BY embedding <=> ${vec}::vector LIMIT ${topK}` as unknown as Array<{content:string;similarity:number}>;
```

**Gotchas**
- `postgres()` IS a pool. Re-instantiating per route (`topup/route.ts:7` + ~14 sibling TMA files) silently exhausts `max_connections`. One instance per process, imported.
- `prepare:false` is mandatory against PgBouncer; both existing `db.ts` files already set it.
- Inside `sql.begin` use the **callback-scoped** `sql`, not the module `sql`, or queries escape the transaction.
- Two-statement balance flows (`SELECT` then `UPDATE`) are racy/double-spend. Guard MUST be in the `UPDATE ... WHERE balance >= cost`.
- `jobId` dedup holds **only while the job still exists in Redis**. `removeOnComplete/Fail` with `age:0`/`true` re-opens the dedup window — use non-zero `age`.
- Per-group/per-key rate limiting (`group.limit`) is **BullMQ PRO**. OSS = worker-global `limiter:{max,duration}` + manual `worker.rateLimit()`+`Worker.RateLimitError`; for per-provider throttling on OSS, shard a queue/worker per provider.
- `repeat:{...}` on `add()` is **deprecated** → `upsertJobScheduler`.
- `CREATE EXTENSION vector` needs superuser; prod app user `aiag` cannot — apply via `sudo -u postgres psql aiag`.
- HNSW plain-`vector` max dim is **2000**; `text-embedding-3-large` (3072) won't fit — use a 1536-dim model or `halfvec`.
- A `vector` column with no dimension can't be indexed; rows need consistent dims before building HNSW.
- `<=>` is cosine **distance** (0=identical, 2=opposite); similarity = `1 - (a <=> b)`. Don't confuse with `<->` (L2) / `<#>` (neg. inner product).

Sources: context7 `/porsager/postgres` (`sql.begin` isolation/ROLLBACK, `UPDATE...RETURNING`, tuple destructure), `/taskforcesh/bullmq` (jobId dedup, `deduplication:{id,ttl}`, `limiter`, `group.limit` Pro, `upsertJobScheduler`), `/pgvector/pgvector` (`CREATE EXTENSION`, `vector(n)`, HNSW `vector_cosine_ops`, `halfvec`). Codebase: `apps/agent-worker/src/db.ts` (correct template), `apps/tg-miniapp/app/api/tma/topup/route.ts:7` (+~14 offenders), `apps/worker/src/queues/contest-eval.ts` (concurrency:2), `apps/worker/src/redis.ts`.

---

### 2.4 Auth + Telegram WebApp — jose hardening + @telegram-apps/sdk-react controls
**Serves:** R0-4/R0-5 (JWT hardening, fail-hard secret, off-Next gateway/worker verify), R3 native WebApp UX wiring.
**Library IDs:** `/panva/jose` (5.9.6 installed), `/websites/telegram-mini-apps_packages` (@telegram-apps/sdk-react 3.3.9 installed)

A JWT-verifying Next.js middleware **already exists** at `apps/tg-miniapp/middleware.ts`: it runs
`jwtVerify(token, JWT_SECRET)` and re-injects verified `payload.sub` as the `x-tma-user-id` header before
forwarding. So the header is **not** externally spoofable for routes behind the matcher — Next overwrites any
client-supplied value. The real R0-4/R0-5 gaps are: no `algorithms` allow-list, no `iss`/`aud` binding,
error-swallowing `catch {}`, a hardcoded secret fallback, and off-Next surfaces (`:4000` gateway, agent-worker)
that don't run the middleware.

```ts
// Harden jwtVerify: pin algorithm + iss/aud, type the error (jose v5: errors namespace)
import { jwtVerify, errors } from 'jose';
const JWT_SECRET = new TextEncoder().encode(process.env.TMA_JWT_SECRET!);   // no fallback in prod
try {
  const { payload } = await jwtVerify(token, JWT_SECRET, {
    algorithms: ['HS256'],         // CRITICAL: blocks alg-confusion (ERR_JOSE_ALG_NOT_ALLOWED)
    issuer: 'aiag-tma',
    audience: 'aiag-gateway',
  });
  const userId = String(payload.sub ?? '');
} catch (err) {
  if (err instanceof errors.JWTExpired) { /* 401 token_expired -> silent re-auth via initData */ }
  else if (err instanceof errors.JOSEAlgNotAllowed) { /* 401 bad_alg */ }
  else { /* 401 invalid_token */ }
}
```

```ts
// Issue HS256 with matching iss/aud
import { SignJWT } from 'jose';
const token = await new SignJWT({ sub: String(user.id), username: user.username })
  .setProtectedHeader({ alg: 'HS256' }).setIssuedAt()
  .setIssuer('aiag-tma').setAudience('aiag-gateway').setExpirationTime('24h').sign(JWT_SECRET);
```

```ts
// Next 14 middleware (Edge): jose uses WebCrypto -> HS256 works with NO Node APIs.
// Do NOT import node:crypto / postgres-js / ioredis into middleware (breaks Edge build).
export const config = { matcher: ['/api/tma/:path*'] };
const reqHeaders = new Headers(req.headers);
reqHeaders.delete('x-tma-user-id');                 // strip spoofed inbound BEFORE re-setting
reqHeaders.set('x-tma-user-id', String(payload.sub ?? ''));
return NextResponse.next({ request: { headers: reqHeaders } });

// Off-Next surfaces (:4000 gateway, agent-worker) MUST verify the JWT themselves — they don't run Next middleware:
import { jwtVerify } from 'jose';
const secret = new TextEncoder().encode(process.env.TMA_JWT_SECRET!);
async function requireUser(authHeader?: string) {
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) throw new Response('no_token', { status: 401 });
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'], issuer: 'aiag-tma' });
  return String(payload.sub);
}
```

```ts
// @telegram-apps/sdk-react v3 — init once at app root, mount themeParams FIRST
import { init, miniApp, themeParams, backButton, mainButton, viewport, hapticFeedback,
         useSignal, retrieveLaunchParams } from '@telegram-apps/sdk-react';
init();
themeParams.mount();   // mount FIRST — buttons read its colors
miniApp.mount(); viewport.mount(); backButton.mount(); mainButton.mount();

// MainButton on run/wizard
useEffect(() => {
  mainButton.setParams({ text: 'Run agent', isVisible: true, isEnabled: true });
  const off = mainButton.onClick(() => submitRun());      // onClick returns an unsubscribe — call in cleanup
  return () => { off(); mainButton.setParams({ isVisible: false }); };
}, []);
// while running: mainButton.setParams({ isLoaderVisible: true, isEnabled: false });

// BackButton on sub-screens
useEffect(() => { backButton.show(); const off = backButton.onClick(() => router.back());
  return () => { off(); backButton.hide(); }; }, []);

// Haptics (feature-gate older clients)
if (hapticFeedback.impactOccurred.isAvailable()) hapticFeedback.impactOccurred('medium');
hapticFeedback.notificationOccurred('success');  // 'success' | 'warning' | 'error'

// Theme + safe-area insets (reactive via useSignal)
const bg = useSignal(themeParams.backgroundColor);
const top = useSignal(viewport.safeAreaInsetTop);
const bottom = useSignal(viewport.safeAreaInsetBottom);
// <div style={{ paddingTop: top, paddingBottom: bottom }} /> ; or viewport.bindCssVars() for pure-CSS

// Launch params for the verify call
const lp = retrieveLaunchParams();        // throws outside Telegram — wrap in try/catch with a dev stub
const initDataRaw = lp.tgWebAppData;      // POST to /api/tma/auth/verify, store returned JWT
```

**Gotchas**
- jose v5 error classes live under `errors`: `import { errors } from 'jose'` → `err instanceof errors.JWTExpired`.
- **alg-confusion:** `jwtVerify` MUST get `{ algorithms: ['HS256'] }` — current `middleware.ts` omits it (the real R0-4 weakness, not the header).
- Existing `middleware.ts` `catch {}` is generic — type it so you can distinguish expired (silent re-auth) vs tampered (hard-fail).
- Secret fallback `?? 'dev-only-change-in-prod'` is in BOTH `middleware.ts` and `auth/verify/route.ts` — make it a required env that throws (R0-5).
- `x-tma-user-id` is safe ONLY behind that exact middleware. Never trust it in the `:4000` gateway / agent-worker; `headers.delete()` inbound before re-setting.
- Keep DB/queue out of Edge middleware (no `node:crypto`/postgres-js/ioredis).
- v3 SDK is **signal-based**: `mount()` each component (themeParams first) before reading signals or you get defaults.
- `onClick(fn)` returns an unsubscribe — call it in cleanup or handlers stack across navigation.
- Feature-gate with `.isAvailable()`/`.isSupported()` (haptics, `miniApp.setClosingConfirmation`) or older clients throw.
- `retrieveLaunchParams()` throws outside Telegram — wrap with a dev fallback.
- **Installed package name is `@telegram-apps/sdk-react`** (^3.3.9); context7 docs say `@tma.js/sdk-react` (alias) — same v3 API, use the installed name in imports.

Sources: context7 `/panva/jose` (`SignJWT`/`jwtVerify` symmetric, `errors.JWTExpired`/`JOSEAlgNotAllowed`, algorithms alg-confusion test), `/websites/telegram-mini-apps_packages` (`useSignal`, `backButton`, `mainButton.setParams/mount`, `hapticFeedback`, `viewport.safeAreaInsets`, `retrieveLaunchParams`). Repo: `apps/tg-miniapp/middleware.ts`, `app/api/tma/auth/verify/route.ts`, `app/api/tma/agents/[id]/run/route.ts`, `apps/tg-miniapp/package.json`.

---

### 2.5 grammY Business Connection + TON jetton transfer + ton-proof
**Serves:** R3 ("agent in your DMs" via Telegram Business), R1/R3 TON top-up (jUSDT transfer), R1-3 ton-proof replay-window verification.
**Library IDs:** `/websites/grammy_dev`, `/ton-community/ton-docs`, `/ton-blockchain/ton-connect`

```ts
// grammY Business Connection — subscribe, identify sender, gate on can_reply
import { Bot } from 'grammy';
const bot = new Bot(process.env.BOT_TOKEN!);
bot.on('business_message', async (ctx) => {
  const text = ctx.msg.text;                  // ctx.businessMessage === ctx.msg
  const conn = await ctx.getBusinessConnection();
  if (ctx.from?.id === conn.user.id) return;  // OWNER typed it — ignore
  if (!conn.rights?.can_reply) return;         // bot lacks reply permission
  await ctx.reply('Hi from your AI agent');    // INSIDE this handler grammY auto-injects business_connection_id
});
bot.on('business_connection', async (ctx) => {
  const bc = ctx.businessConnection;           // { id, user, user_chat_id, is_enabled, rights }
  // persist bc.id <-> agent mapping (you'll need bc.id for async worker replies)
});

// Async reply from the BullMQ worker (NOT a business ctx) -> pass business_connection_id EXPLICITLY:
await bot.api.sendMessage(chatId, 'async agent reply', { business_connection_id: businessConnectionId });
```

```ts
// webhookCallback on Bun — use 'std/http' adapter, NOT 'express'
import { webhookCallback } from 'grammy';
const handleUpdate = webhookCallback(bot, 'std/http', { secretToken: process.env.TG_WEBHOOK_SECRET });
Bun.serve({ port: Number(process.env.PORT ?? 3000), async fetch(req) {
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname === '/tg/webhook') {
    try { return await handleUpdate(req); } catch { return new Response('error', { status: 500 }); }
  }
  return new Response('ok');
}});
// Business updates are NOT in default allowed_updates — list them explicitly or Telegram never delivers them:
await bot.api.setWebhook('https://ai-aggregator.ru/tg/webhook', {
  secret_token: process.env.TG_WEBHOOK_SECRET,
  allowed_updates: ['message','business_connection','business_message','edited_business_message','deleted_business_messages'],
});
```

```ts
// TON jUSDT (6-decimal) jetton transfer — op 0xf8a7ea5 sent to the SENDER's OWN jetton wallet
import { beginCell, toNano, Address, internal, storeMessageRelaxed } from '@ton/ton';
function buildJUsdtTransferBody(opts: {
  amount: bigint; destination: Address; responseTo: Address; forwardTon?: bigint; comment?: string;
}) {
  const fwd = opts.forwardTon ?? 1n;            // 1 nanoton notify; 0n = no transfer-notification
  let b = beginCell()
    .storeUint(0xf8a7ea5, 32).storeUint(0n, 64)  // op, query_id
    .storeCoins(opts.amount)                      // 6-decimal base units — DO NOT use toNano() (toNano = 9 decimals)
    .storeAddress(opts.destination).storeAddress(opts.responseTo)
    .storeBit(0).storeCoins(fwd);                 // no custom_payload, forward_ton_amount
  if (opts.comment) {
    const payload = beginCell().storeUint(0, 32).storeStringTail(opts.comment).endCell();
    b = b.storeBit(1).storeRef(payload);
  } else b = b.storeBit(0);
  return b.endCell();
}
const body = buildJUsdtTransferBody({
  amount: 1_000_000n,                             // 1.00 jUSDT (6 decimals); toNano('1') would move 1000 USDT!
  destination: Address.parse(OUR_RECEIVING_WALLET), responseTo: senderWallet, comment: topUpTag,
});
const msg = internal({ to: senderJettonWallet, value: toNano('0.05'), bounce: true, body });  // value = gas
const cell = beginCell().store(storeMessageRelaxed(msg)).endCell();   // base64 -> TonConnect messages[].payload
// Resolve senderJettonWallet via the jUSDT master's get_wallet_address(owner) get-method.
```

```ts
// Server-side ton-proof verifier — REPLACES the verifyTonProof() no-op stub at apps/tg-miniapp/src/lib/ton-proof.ts
import { sha256 } from '@ton/crypto';
import { Address, Cell, contractAddress, loadStateInit } from '@ton/ton';
import { sign } from 'tweetnacl';                  // sign.detached.verify(msg, sig, pubkey) — Ed25519
import { tryParsePublicKey } from './wallets-data'; // PROJECT CODE — must be vendored (see gap)
const TON_PROOF_PREFIX = 'ton-proof-item-v2/'; const TON_CONNECT_PREFIX = 'ton-connect';
const VALID_AUTH_TIME = 15 * 60;
export async function checkTonProof(p, allowedDomains: string[], getPubKeyOnchain?): Promise<boolean> {
  const stateInit = loadStateInit(Cell.fromBase64(p.proof.state_init).beginParse());
  const pub = tryParsePublicKey(stateInit) ?? (getPubKeyOnchain ? await getPubKeyOnchain(p.address) : null);
  if (!pub) return false;
  if (!pub.equals(Buffer.from(p.public_key, 'hex'))) return false;       // pubkey matches claim
  const wanted = Address.parse(p.address);
  if (!contractAddress(wanted.workChain, stateInit).equals(wanted)) return false;  // stateInit hash == address
  if (!allowedDomains.includes(p.proof.domain.value)) return false;
  if (Math.floor(Date.now()/1000) - VALID_AUTH_TIME > p.proof.timestamp) return false;  // freshness
  const wc = Buffer.alloc(4); wc.writeUInt32BE(wanted.workChain, 0);     // workchain = 4B BIG-endian
  const ts = Buffer.alloc(8); ts.writeBigUInt64LE(BigInt(p.proof.timestamp), 0);  // timestamp = 8B LITTLE-endian
  const dl = Buffer.alloc(4); dl.writeUInt32LE(p.proof.domain.lengthBytes, 0);     // domain len = 4B LITTLE-endian
  const msg = Buffer.concat([Buffer.from(TON_PROOF_PREFIX), wc, wanted.hash, dl,
    Buffer.from(p.proof.domain.value), ts, Buffer.from(p.proof.payload)]);
  const msgHash = Buffer.from(await sha256(msg));
  const fullMsg = Buffer.concat([Buffer.from([0xff,0xff]), Buffer.from(TON_CONNECT_PREFIX), msgHash]);
  const signedHash = Buffer.from(await sha256(fullMsg));                 // sha256(0xffff ++ 'ton-connect' ++ sha256(msg))
  return sign.detached.verify(signedHash, Buffer.from(p.proof.signature, 'base64'), pub);
}
```

```ts
// TonConnect: request ton_proof at connect time so the wallet returns a signature
import { TonConnectUI } from '@tonconnect/ui';
const tonConnectUI = new TonConnectUI({ manifestUrl });
const { payload } = await fetch('/api/ton/proof-nonce').then(r => r.json());   // server nonce BEFORE connect
tonConnectUI.setConnectRequestParameters({ state: 'ready', value: { tonProof: payload } });
tonConnectUI.onStatusChange((w) => {
  if (w?.connectItems?.tonProof && 'proof' in w.connectItems.tonProof) {
    const { proof } = w.connectItems.tonProof;
    fetch('/api/ton/check-proof', { method:'POST', body: JSON.stringify({
      address: w.account.address, public_key: w.account.publicKey, proof }) });
  }
});
```

**Gotchas**
- grammY auto-injects `business_connection_id` only **inside** a `business_message` ctx. From the BullMQ worker you MUST pass it explicitly — persist `bc.id`.
- Business updates are excluded from default `allowed_updates` — list all four explicitly in `setWebhook`/`getUpdates`.
- On Bun use the `'std/http'` adapter, not `'express'`; pass `secretToken` and validate `X-Telegram-Bot-Api-Secret-Token`.
- **jUSDT/USDT are 6 decimals; `toNano()` is hardwired to 9** — using it for the jetton amount overpays 1000×. Compute `usdt * 10^6` as bigint and `storeCoins()`. Only message `value` (0.05 TON gas) and `forward_ton_amount` use `toNano`/nanotons.
- The transfer body goes to the **SENDER's own jetton wallet** (resolved via master `get_wallet_address`), not the master and not the recipient. The recipient is the `destination` field inside the body.
- ton-proof endianness is mixed: workchain 4B **BIG**-endian; timestamp 8B + domain length 4B **LITTLE**-endian. The double-hash domain separation (`0xffff ++ 'ton-connect' ++ sha256(message)`) is mandatory.
- The current `verifyTonProof(proof, address, domain)` stub cannot work — the verifier also needs `public_key` and `state_init` from `TonAddressItemReply`. Widen the signature.
- Generate the proof `payload` nonce server-side (`getSecureRandomBytes(32)`), bind to session, verify `=== proof.payload` (replay), enforce the 15-min window + `allowedDomains`.

Sources: `https://grammy.dev/advanced/business`, `https://grammy.dev/guide/deployment-types` (webhookCallback `std/http`, `allowed_updates`); ton-docs `ton-connect/cookbook/jetton-transfer.mdx`, `dapps/cookbook.mdx`, `dapps/transactions/message-driven-execution.mdx`, `ton-connect/verifying-signed-in-users.mdx`, `ton-connect/frameworks/react.mdx`; `ton-blockchain/ton-connect/requests-responses.md#address-proof-signature-ton_proof`. Local: `apps/tg-miniapp/src/lib/ton-proof.ts`.

---

### 2.6 Observability — OpenTelemetry JS + self-hosted Langfuse
**Serves:** R2-3 (tracing the worker→gateway path, LLM generation + token/cost capture for billing audit).
**Library IDs:** `/open-telemetry/opentelemetry-js`, `/langfuse/langfuse-js`, `/langfuse/langfuse-docs`

```ts
// otel.ts — ONE NodeSDK per process (worker AND gateway). Import FIRST (node -r ./otel.js or top of entrypoint).
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { propagation } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
propagation.setGlobalPropagator(new W3CTraceContextPropagator());   // REQUIRED for inject/extract in BOTH processes
const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'aiag-worker' }),   // or 'aiag-gateway'
  spanProcessors: [ new BatchSpanProcessor(new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT })) ],                // collector OR Langfuse /api/public/otel/v1/traces
  instrumentations: [ getNodeAutoInstrumentations() ],
});
sdk.start();
process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));   // flush before exit
```

```ts
// Manual spans around the loop + each tool call (auto-parented via active context)
import { trace, SpanStatusCode } from '@opentelemetry/api';
const tracer = trace.getTracer('aiag-agent', '1.0.0');
await tracer.startActiveSpan('agent.run', async (loopSpan) => {
  loopSpan.setAttribute('agent.run_id', runId);
  try {
    for (const step of steps) {
      await tracer.startActiveSpan(`tool.${step.name}`, async (toolSpan) => {
        try { await callTool(step); }
        catch (e) { toolSpan.recordException(e as Error); toolSpan.setStatus({ code: SpanStatusCode.ERROR }); throw e; }
        finally { toolSpan.end(); }          // MUST end EVERY span or it never exports
      });
    }
  } catch (e) { loopSpan.recordException(e as Error); loopSpan.setStatus({ code: SpanStatusCode.ERROR }); throw e; }
  finally { loopSpan.end(); }
});
```

```ts
// Cross-process trace: BullMQ/Redis does NOT carry OTel context — INJECT on add(), EXTRACT in the processor.
import { propagation, context, trace } from '@opentelemetry/api';
// sender (worker enqueue or HTTP call to :4000):
const carrier: Record<string,string> = {};
propagation.inject(context.active(), carrier);
await queue.add('agent-run', { ...payload, _otel: carrier });                 // Redis hop
await fetch('http://gateway:4000/v1/chat/completions', { headers: { ...carrier, 'content-type':'application/json' }, body });
// receiver (gateway handler / worker processor):
const parentCtx = propagation.extract(context.active(), job.data._otel /* or req.headers */);
await context.with(parentCtx, async () => {
  await tracer.startActiveSpan('gateway.chat_completion', async (span) => { try { /* proxy + debit */ } finally { span.end(); } });
});
```

```ts
// Langfuse v4 (self-hosted): LangfuseSpanProcessor on the SAME NodeSDK + record a generation with usage/cost
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { startObservation, updateActiveTrace } from '@langfuse/tracing';
export const langfuseSpanProcessor = new LangfuseSpanProcessor({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY!, secretKey: process.env.LANGFUSE_SECRET_KEY!,
  baseUrl: process.env.LANGFUSE_BASE_URL,        // https://langfuse.ai-aggregator.ru (self-hosted)
  environment: process.env.NODE_ENV ?? 'production',
});
// const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor, otlpProcessor] });  // can coexist. Node 20+.
updateActiveTrace({ name: 'agent.run', userId: tgUserId, sessionId: chatId });
const gen = startObservation('llm-call', { model: 'gpt-4o-mini', input: messages, modelParameters: { temperature: 0.7 } },
  { asType: 'generation' });
gen.update({
  output: completion.choices[0].message,
  usageDetails: { input: usage.prompt_tokens, output: usage.completion_tokens, total: usage.total_tokens },
  costDetails: { input: 0.000047, output: 0.0000094, total: 0.0000564 },   // USD; omit to let Langfuse price by model
});
gen.end();
await langfuseSpanProcessor.forceFlush();        // flush before a short-lived BullMQ job/handler exits

// SDK-FREE option: any OTel process can export straight to self-hosted Langfuse:
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://langfuse.ai-aggregator.ru/api/public/otel/v1/traces"
//   exporter headers: { Authorization: 'Basic ' + btoa(`${publicKey}:${secretKey}`) }   // HTTP Basic, NOT bearer
```

**Gotchas**
- Every span MUST be `.end()`'d (try/finally) — the `startActiveSpan` callback return does NOT auto-end.
- **BullMQ/Redis breaks the active context** — inject into JobData on `add()`, extract+`context.with()` in the processor, or the worker starts a NEW trace.
- Set the global W3C propagator in BOTH processes or inject/extract silently no-op; HTTP auto-instrumentation only extracts `traceparent` when it's registered.
- Bootstrap OTel BEFORE importing http/express/postgres (auto-instrumentations monkey-patch on require).
- **Langfuse v4 split the SDK:** monolithic `langfuse` (`langfuse.generation()`/`.trace()`) is superseded by `@langfuse/otel` + `@langfuse/tracing` (`startObservation`, `asType:'generation'`, `usageDetails`/`costDetails`). Don't mix v2/v3 names.
- `costDetails`/`usageDetails` keys are `input`/`output`/`total` (v4), NOT `promptTokens`/`completionTokens`. For white-labeled upstreams set `costDetails` explicitly (Langfuse can't auto-price an unknown model name).
- `BatchSpanProcessor` delays export (~5s) — short-lived jobs need `forceFlush()`/`sdk.shutdown()` or you lose spans.
- Langfuse OTLP path is `/api/public/otel/v1/traces`; auth is HTTP Basic `base64(publicKey:secretKey)`.

Sources: context7 `/open-telemetry/opentelemetry-js` (NodeSDK, OTLP exporter, W3C propagator, inject/extract), `/langfuse/langfuse-js` (`LangfuseSpanProcessor`, `startObservation`/`updateActiveTrace`, `forceFlush`, self-hosted baseUrl), `/langfuse/langfuse-docs` (generation usage/cost ingestion, `/api/public/otel/v1/traces`). Local: `apps/worker/src/queues/*.ts` (typed BullMQ JobData = carrier for `traceparent`).

---

## 3. Corrections to prior research (2026-06-02)

These contradict assumptions in the eval/roadmap. **Treat them as authoritative — they come from a fresh
context7 pass on the installed/current versions.**

**MCP gateway + Hono**
- The single-transport pattern (`const transport = new WebStandard...; app.all('/mcp', c => transport.handleRequest(...))`) is correct ONLY for a **single global server**. For per-tenant `/t/:agentId/mcp` it MUST move INSIDE the handler as a fresh per-request factory (confirmed by `simpleStatelessStreamableHttp.ts`).
- `createMcpHonoApp` exists but wraps a **shared** transport — for multi-tenant + pre-transport auth use a plain `new Hono()` + manual factory, not `createMcpHonoApp`.
- Auth is NOT the SDK's `requireBearerAuth` (Express-only) on the Hono/WebStandard path — it's a Hono middleware + explicit `{ authInfo }` hand-off.

**Agent runtime**
- Roadmap says "Vercel AI SDK **v6**". **CORRECTION: there is no `ai` v6 on npm** (2026-06-02). Latest stable is v5; v7/next is the prerelease line. Plan against v5 (`stepCountIs`).
- Roadmap says "**`ToolLoopAgent`** with stopWhen/prepareStep". **CORRECTION: the class is `Agent`** (from `ai`); `stopWhen`/`prepareStep` are real fields on it and on `generateText`/`streamText`. There is no `ToolLoopAgent` symbol — that import fails.
- "Keep the custom loop" is **more viable than the brief implies** — the existing for-loop already does what `stopWhen`+`onStepFinish` do. AI SDK's wins are typed tools, `useChat` streaming UI, and a clean `Agent` abstraction, NOT loop correctness.
- **Mastra is NOT required for tool-loop + memory** — AI SDK + a pgvector tool you already own covers it. Mastra earns its place only for `MCPClient` and managed semantic-recall Memory.

**Billing / data**
- "A pool per route module — wrong" is confirmed and worse: `postgres()` is itself a managed pool, so each module-scope call = an entire extra pool (up to `max:10`). Fix = a single shared instance, not pool tuning.
- `apps/agent-worker/src/db.ts` **already implements** the correct atomic pattern. The financial-integrity gap is (a) the user-balance deduct through the gateway and (b) the TMA Next.js routes each spinning up their own pool — NOT the worker.
- BullMQ docs now steer toward `upsertJobScheduler` over `add(...,{repeat})`; `deduplication:{id,ttl}` is a distinct newer alternative to jobId-based dedup.

**Auth + Telegram WebApp**
- The eval framed `x-tma-user-id` as "a spoofable header replacing the JWT". **REALITY:** a `jwtVerify`-based middleware already exists and OVERWRITES it from the verified `sub`. The fix is to HARDEN `jwtVerify` (algorithms allow-list, iss/aud, typed errors, required secret) and to verify the JWT on off-Next surfaces (`:4000`, agent-worker) — NOT to build a new auth layer.
- Native WebApp controls are a **wiring gap, not an install** — `@telegram-apps/sdk-react@3.3.9` is already a dependency. No package addition for R0-4/R3 UI controls.
- Docs use `@tma.js/sdk-react`; the repo installs `@telegram-apps/sdk-react` (^3.3.9) — same v3 signal API; use the installed name.

**grammY + TON**
- `verifyTonProof()` is NOT a "simple add `signVerify`" fix — the stub signature `verifyTonProof(proof, address, domain)` is insufficient; the reference verifier ALSO needs `public_key` + `state_init` plus the pubkey↔stateInit-hash↔address triple check. **The fix is an interface change.**
- The canonical verifier uses tweetnacl's `sign.detached.verify` over `sha256(0xffff ++ 'ton-connect' ++ sha256(msg))`. `@ton/crypto.signVerify` is equivalent (both Ed25519), but the **double-SHA256 + 0xffff domain separation is the load-bearing part**, not the verify call.
- "Send jetton with `toNano` amount" is the **single most likely production money bug** — jUSDT is 6 decimals; `toNano` (9 decimals) overpays 1000×. Only the message `value` (0.05 TON) and `forward_ton_amount` use `toNano`.
- "`agent in your DMs` sets `business_connection_id` on every send" is half-true — inside a `business_message` ctx grammY injects it; the explicit set is needed only for out-of-context (worker) sends.

**Observability**
- The research assumed the legacy monolithic `langfuse` JS SDK. **CURRENT (v4) is OTel-native:** `@langfuse/otel` `LangfuseSpanProcessor` + `@langfuse/tracing` `startObservation`/`startActiveObservation` with `{ asType: 'generation' }`.
- Cost via `costDetails:{input,output,total}` and usage via `usageDetails:{input,output,total}` — NOT the v2-era `usage:{input,output,unit,input_cost,output_cost}`.
- Langfuse can be used **WITHOUT its SDK** on worker/gateway — it ingests raw OTel spans at `/api/public/otel/v1/traces`, so the OTel NodeSDK can dual-export (collector + Langfuse).
- OTel JS provider registration moved to `spanProcessors: [...]` on the constructor; `provider.addSpanProcessor()` is deprecated.

---

## 4. Gaps we had NOT researched (now filled) — ranked by dev importance

> Each item: why it matters → the concrete fix. **#1–#5 are production must-haves the roadmap under-specified.**

**#1 — SECURITY (urgent): Next.js 14.2.15 is below the CVE floor.** Vulnerable to **CVE-2025-29927** (critical
middleware auth-bypass, fixed 14.2.25), **55173** (14.2.31), **57822** (middleware SSRF, 14.2.32) + 2026
mw/proxy-bypass. Since our entire R0-4 auth model is *middleware-based*, the auth bypass is directly
exploitable. **FIX: PATCH to the latest 14.2.x (≥14.2.33) — stay on 14.x, do NOT major-upgrade. Also strip
`x-middleware-subrequest` at nginx (`proxy_set_header x-middleware-subrequest "";`).** Source: `/vercel/next.js`.

> **Next.js 14 stay-vs-upgrade decision (called out explicitly):** **STAY on 14.x, PATCH to ≥14.2.33.** A
> major upgrade to 15/16 is out of scope for R0–R3, risks the App Router / middleware / `useChat` surface, and
> is not required to close the CVEs — the 14.2.x patch line fully remediates them. Defer any 15+ migration to a
> dedicated post-remediation spike.

**#2 — Idempotency (financial integrity).** No `webhook_events` table, no run-id deduct guard → NFT/TON top-up
replays double-credit; BullMQ retries double-debit. **FIX:** `webhook_events(id PK = txHash)` with
`INSERT ... ON CONFLICT(id) DO NOTHING RETURNING id` (skip if 0 rows); deduct via CAS on status:
`WITH done AS (UPDATE agent_runs SET status='completed' WHERE id=${runId} AND status<>'completed' RETURNING tg_user_id) UPDATE balances ... FROM done`. (BullMQ jobId dedups the JOB but the TON tx also needs the DB unique constraint to be truly exactly-once.)

**#3 — Rate limiting (none today).** Gateway / run / BYOK-verify / manifesto endpoints are unthrottled →
trivial abuse + cost blowout. **FIX:** `rate-limiter-flexible` `RateLimiterRedis({ storeClient: ioredis, points: 30, duration: 60 })`
over the **EXISTING ioredis** — NOT `@upstash/ratelimit` (REST-only). Per-user ~30/min, per-IP on the gateway, stricter for unauth.

**#4 — Migration tracking.** Prod hand-applies `0004`–`0026.sql` untracked while a dormant drizzle journal
competes → no source of truth, replay risk. **FIX:** `CREATE TABLE schema_migrations(version text PRIMARY KEY, checksum text)`;
apply only un-recorded `*.sql` per-file in a txn; backfill `0004`–`0026`; retire the drizzle journal (or fully adopt `drizzle-kit migrate`).

**#5 — Embeddings pipeline (R3-4 names pgvector but no model/route/schema).** **FIX:** `POST /v1/embeddings`
through the `:4000` gateway (so it's **billed**), `text-embedding-3-small` (1536) or `bge-m3` (1024, better RU);
`vector(1536)` + HNSW `vector_cosine_ops` + `<=>`; respect the 2000-dim HNSW ceiling (`halfvec` above 2000).
Generate via AI SDK `embed()`/`embedMany()` so it routes through billing, not Mastra's in-process `fastembed`.

**#6 — Secrets-at-rest.** BYOK keys are AES-GCM'd but the master key sits in `/srv/aiag/shared/.env` on the same
host → host compromise = all keys plaintext. **FIX:** root-owned `400` file (systemd `LoadCredential`), envelope
encryption (DEK + KEK), Yandex Cloud KMS / Vault transit for the KEK.

**#7 — BullMQ dead-letter / failure sink.** `agent-worker` has no `attempts`/`backoff`/DLQ → failed runs vanish,
stuck "pending" forever. **FIX:** `Worker({ attempts: 3, backoff: { type: 'exponential' } })`; on exhausted
`'failed'` → push to a dead-letter queue + `markFailed(runId)`; set `removeOnFail` retention.

**#8 — JWT freshness / revocation.** 24h tokens, no refresh/revocation → a leaked token spends indefinitely.
**FIX:** short-lived JWT (~15m) + refresh flow; Redis denylist for revocation; tie to the R1-3 replay window.
(The typed `JWTExpired` catch from §2.4 enables silent re-auth via `initData`.)

**#9 — Backup / restore + DR.** No documented PG backup/PITR/restore drill for balances/ledger/keys. **FIX:**
nightly `pg_dump` (or `wal-g`/`pgBackRest` PITR) off-box to an encrypted S3 bucket; a restore runbook with tested RPO/RTO.

**#10 — Moderation / abuse.** Arbitrary prompts → LLM → Telegram DMs/channels with no moderation, velocity caps,
or output audit. **FIX:** in/out moderation hook, abuse heuristics (signup/run velocity, first-run-free abuse),
per-agent kill switch. (152-FZ / ToS prerequisite given Russia jurisdiction.)

**#11 — SLOs / error budgets / health checks.** Traces but no SLOs, alerts, or liveness/readiness on pm2 (and
`pm2 reload` can leave a stale process — see infra memory). **FIX:** error budgets (run success rate, p95
latency, 5xx), alerts off Langfuse/OTel, `/health`+`/ready` checked post-reload.

**Domain/schema confirmations still needed (block #2 deduct):** confirm the column holding spendable RUB
(`tg_users.balance_rub` materialized vs derived from topups−spend); if derived you need a materialized balance
column or a ledger+guard, not a `SELECT SUM`. SERIALIZABLE deduct can raise `40001` — wrap the money path in a
retry-on-`40001` loop (postgres-js does not auto-retry).

---

## 5. Open spikes still needed (context7 could not fully answer)

These require a **lockfile grep, a VPS check, or an architecture decision** — not more docs.

1. **`@modelcontextprotocol/*` installed major** (lockfile) — decides `extra.authInfo` (v1) vs `ctx.http?.authInfo` (v2) and the exact `AuthInfo` interface fields. Grep before writing tool handlers.
2. **Gateway JWT algorithm + claim schema** — does `:4000` mint HS256 (shared secret) or RS256 (→ `jwk()`)? What claims (`sub`=userId? agentId? balance/scopes)? Confirm `TMA_JWT_SECRET` is the SAME value in `/srv/aiag/shared/.env` that the gateway loads, or gateway-side verify won't match TMA-minted tokens.
3. **Where the per-request balance debit fires** in the MCP/Hono chain (middleware vs inside the tool handler) and how partial multi-step runs are billed vs refunded on failure — needs gateway route inspection (memory flags "agent runs bypass gateway → billing skipped" as the live P0).
4. **Gateway runtime (Bun vs Node) + entrypoint location** — `apps/gateway/src` was not found at that path. OTel auto-instrumentation and `@langfuse/otel` target Node 20+; Bun support is partial. Locate the entrypoint and validate monkey-patching works or fall back to manual spans.
5. **Edge-runtime confirmation for `middleware.ts`** in Next 14.2.15 (no accidental `export const runtime='nodejs'`) so the jose WebCrypto assumption holds.
6. **`tryParsePublicKey(stateInit)`** is project code (wallet v3/v4/v5/W5 code-hash → data layout) — must be vendored, or fall back to on-chain `get_public_key` via a TonClient (needs an RPC endpoint + API key, rate-limit handling). Also confirm the **mainnet jUSDT/USDT master address** and its **decimal count (6)** against the jetton metadata before shipping — a wrong decimal is silent fund loss.
7. **grammY version pin** — confirm `apps/tg-miniapp`/`agent-worker` are on grammY ≥1.21 (Bot API ≥7.2) for Business Connection support.
8. **Webhook ownership / runtime decision** — does `/tg/webhook` terminate in a Next route handler, a standalone Bun process, or the Hono gateway? The `webhookCallback` adapter choice (`std/http` vs Hono's own) depends on this.
9. **`@langfuse/otel` + `@langfuse/tracing` exact versions** (`npm view @langfuse/otel version`) and **Langfuse self-host infra footprint** (Compose vs Helm; Postgres/Clickhouse/Redis/S3 backing services) on the VPS.
10. **Bun smoke test on the VPS** (per no-local-runtime rule) for: `@mastra/pg` (node-postgres), `fastembed` ONNX, AI SDK streaming, OTel auto-instrumentation. Not verifiable in research.
11. **`closingConfirmation` export shape in sdk-react 3.3.9** — `miniApp.setClosingConfirmation(...)` vs a `closingBehavior` component with `enableConfirmation()` — confirm against the installed `.d.ts`.
12. **`verifyInitData` audit** (`@/lib/verify-init-data`, root of trust for minting the JWT) — confirm it checks `auth_date` freshness + HMAC hash correctly. Add unit tests for the hardened middleware (`ERR_JOSE_ALG_NOT_ALLOWED`, `JWTExpired`).
13. **Connection-limit budgeting** across web + N workers + agent-worker (each its own pool `max`) vs Postgres `max_connections` / PgBouncer pool size — capacity math not done.
14. **AI SDK / Mastra OTel spans vs manual Langfuse generations** — `experimental_telemetry` already emits GenAI spans; cross-check whether manual `startObservation` is redundant. Consider `@opentelemetry/instrumentation-bullmq` to automate the Redis-hop propagation.
