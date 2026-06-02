# Coding Conventions

**Analysis Date:** 2026-06-02
**Scope:** `apps/tg-miniapp/`, `apps/agent-worker/`, shared gateway/worker billing path

---

## Naming Patterns

**Files:**
- API route files: always `route.ts` inside Next.js App Router directories (e.g. `app/api/tma/agents/[id]/route.ts`)
- Library utilities: `kebab-case.ts` (e.g. `verify-init-data.ts`, `ton-rate.ts`, `external-agent.ts`)
- React pages: `page.tsx` per Next.js App Router convention
- Worker source: flat `kebab-case.ts` files in `apps/agent-worker/src/` (e.g. `agent-runner.ts`, `bot-api.ts`)

**Functions:**
- camelCase for all functions: `verifyInitData`, `getTonRubRate`, `encryptSecret`, `runAgent`
- Boolean helpers use verb prefixes: `isPrivateIPv4`, `isTokenUsable`
- DB helpers use action verbs: `loadRun`, `loadAgent`, `markStarted`, `markCompleted`, `markFailed`

**Variables:**
- camelCase: `tgUserId`, `walletAddress`, `amountRub`
- Constants: `SCREAMING_SNAKE_CASE` for module-level (`UUID_RE`, `MAX_ITERATIONS`, `USD_TO_RUB`, `PRICING`)
- Postgres tag: always named `sql` at module scope

**Types/Interfaces:**
- PascalCase interfaces: `AgentRow`, `RunRow`, `TGUser`, `ProbeResult`
- Row types are co-located in the file where used (no shared DB types package for TMA — separate definitions in each route file and in `agent-worker/src/db.ts`)
- Union return types use `| { ok: true; ... } | { ok: false; reason: string }` discriminated pattern (e.g. `VerifyResult` in `verify-init-data.ts`)

---

## SQL / Database Access

### Hard Rule Compliance: SQL prepared statements

**VIOLATION — all TMA routes use `{ prepare: false }`:**

Every single route file creates its own top-level postgres client with:
```typescript
const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });
```

This appears in all 14 route files:
- `apps/tg-miniapp/app/api/tma/agents/route.ts:10`
- `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts:7`
- `apps/tg-miniapp/app/api/tma/agents/[id]/run/route.ts:7`
- `apps/tg-miniapp/app/api/tma/auth/verify/route.ts:8`
- `apps/tg-miniapp/app/api/tma/marketplace/route.ts:6`
- `apps/tg-miniapp/app/api/tma/marketplace/[slug]/route.ts:6`
- `apps/tg-miniapp/app/api/tma/nft/collections/route.ts:7`
- `apps/tg-miniapp/app/api/tma/nft/purchase/route.ts:8`
- `apps/tg-miniapp/app/api/tma/nft/webhook/route.ts:7`
- `apps/tg-miniapp/app/api/tma/topup/route.ts:7`
- `apps/tg-miniapp/app/api/tma/topup/init/route.ts:9`
- `apps/tg-miniapp/app/api/tma/topup/check/[id]/route.ts:7`
- `apps/tg-miniapp/app/api/tma/wallet/route.ts:7`
- `apps/tg-miniapp/app/api/tma/wallet/link/route.ts:7`
- `apps/agent-worker/src/db.ts:9`

`prepare: false` disables PostgreSQL server-side prepared statements. The intent is pgBouncer compatibility (pgBouncer in transaction mode cannot use extended query protocol). This is a known trade-off, NOT SQL injection — the `postgres` library still parameterises all values via tagged template literals (e.g. `sql\`WHERE id = ${params.id}::uuid\``). There is **zero string interpolation** into query text in any of these files. The project rule "SQL must use prepared statements" is partially violated at the driver level but fully complied with at the injection-safety level.

**Pattern used (correct):**
```typescript
// CORRECT — value passed as parameter, not interpolated
const rows = await sql`
  SELECT id::text FROM agents
  WHERE id = ${params.id}::uuid
    AND tg_user_id = ${tgUserId}::bigint
    AND status = 'active'
  LIMIT 1
`;
```

**Pattern NOT used (would be an injection):**
```typescript
// NEVER appears — confirmed absent
const rows = await sql(`SELECT ... WHERE id = '${params.id}'`);
```

**Additional issue:** Each route file creates its own `postgres()` client at module scope. This means up to 14 separate connection pools competing. The agent-worker consolidates correctly in `apps/agent-worker/src/db.ts`.

---

## Auth Pattern

### Hard Rule Compliance: `getAuthenticatedUser()` → `authUser.user.id`

**NOT APPLICABLE to TMA** — the TMA stack does not use `getAuthenticatedUser()`. This is the web app (`apps/web`) auth pattern. The TMA has its own parallel auth stack:

1. **Client:** `apps/tg-miniapp/src/hooks/useAuth.ts` — calls `POST /api/tma/auth/verify` with `initData` from Telegram WebApp SDK, caches the returned JWT in Telegram CloudStorage
2. **Server (auth endpoint):** `apps/tg-miniapp/app/api/tma/auth/verify/route.ts` — verifies HMAC-SHA256 of `initData` against `TELEGRAM_BOT_TOKEN`, issues a HS256 JWT (`sub` = telegram_id as string, 24h expiry) via `jose`
3. **Server (middleware):** `apps/tg-miniapp/middleware.ts` — validates JWT on all `/api/tma/*` routes (except public ones), injects `x-tma-user-id` header
4. **Route handlers:** read `req.headers.get('x-tma-user-id')` — every protected route checks this and returns 401 if missing

**Middleware public allowlist** (bypasses JWT check):
```typescript
path.startsWith('/api/tma/auth/')     // verify endpoint
path === '/api/tma/nft/collections'  // public catalog
path === '/api/tma/nft/webhook'      // Startonus callback (nginx IP-allowlist)
path.startsWith('/api/tma/marketplace') // public model list
```

**NOTE:** The TMA user identity is a Telegram `bigint` ID, not a UUID. There is no linkage to the web app's `users` table.

---

## Hard Rule Compliance: Atomic DB writes

**COMPLIANT with caveats:**

**`getOrResetDailyBucket` — correct atomic reset:**
```typescript
// apps/agent-worker/src/db.ts:88
await sql`
  UPDATE agents
     SET spent_today_rub  = CASE
           WHEN spent_today_date < (now() AT TIME ZONE 'Europe/Moscow')::date THEN 0
           ELSE spent_today_rub
         END,
         spent_today_date = (now() AT TIME ZONE 'Europe/Moscow')::date
   WHERE id = ${agentId}::uuid
   RETURNING daily_budget_rub::text, spent_today_rub::text
`
```
Uses `UPDATE ... RETURNING` for atomic read+write. Race-safe.

**`topup/check/[id]/route.ts` — correct idempotent credit:**
```typescript
// apps/tg-miniapp/app/api/tma/topup/check/[id]/route.ts:134
await sql`
  UPDATE tg_topups
  SET status = 'confirmed', tx_hash = ${matched.hash}, confirmed_at = NOW()
  WHERE id = ${topup.id}::uuid AND status = 'pending'
  RETURNING id::text
`
// Only credits balance if RETURNING had rows (concurrent-safe)
```

**NFT webhook `minted` event — uses explicit transaction:**
```typescript
// apps/tg-miniapp/app/api/tma/nft/webhook/route.ts:73
await sql.begin(async (tx) => {
  await tx`UPDATE nft_purchases SET status = 'minted' ... WHERE status <> 'minted'`;
  await tx`UPDATE nft_collections SET minted_count = minted_count + 1 ...`;
});
```

**PARTIAL VIOLATION — `incrementDailySpend` lacks RETURNING:**
```typescript
// apps/agent-worker/src/db.ts:113
await sql`
  UPDATE agents
     SET spent_today_rub = spent_today_rub + ${deltaRub}
   WHERE id = ${agentId}::uuid
`  // No RETURNING, no concurrency guard
```
This is a blind increment. Under concurrent runs for the same agent, two workers could both pass the budget gate, then both increment — potentially over-spending the daily budget.

**PARTIAL VIOLATION — `markStarted`, `markCompleted`, `markFailed` lack concurrency guards:**
```typescript
// apps/agent-worker/src/db.ts — all three UPDATE without WHERE status = 'expected_state'
await sql`UPDATE agent_runs SET status = 'running' WHERE id = ${runId}::uuid`
```
No `RETURNING` check. A double-processing race condition (BullMQ retry + duplicate job) could cause both to mark the run as completed.

---

## Hard Rule Compliance: No hardcoded prices

**VIOLATION in `apps/agent-worker/src/agent-runner.ts`:**

The agent-worker hardcodes LLM pricing directly in source:
```typescript
// apps/agent-worker/src/agent-runner.ts:56
const PRICING: Record<string, { in: number; out: number }> = {
  'nousresearch/hermes-4-405b':        { in: 0.9,  out: 1.5  },
  'openai/gpt-4o':                     { in: 2.5,  out: 10.0 },
  'anthropic/claude-3.5-sonnet':       { in: 3.0,  out: 15.0 },
  // ...
};
const FALLBACK_PRICE = { in: 1.0, out: 2.0 };
const USD_TO_RUB = 90; // hardcoded exchange rate
```

The project-level pricing lib is at `packages/api-gateway/src/lib/pricing.ts` (`calcCostRub`). The agent-worker does NOT import this — it re-implements pricing inline and uses a static USD→RUB rate instead of the live CBR rate used by the gateway. This means agent-worker costs drift from gateway costs and from actual market rates.

**Also hardcoded in `apps/tg-miniapp/app/api/tma/topup/init/route.ts`:**
```typescript
const MIN_RUB = 100;
const MAX_RUB = 50_000;
```
These are business limits, not prices — acceptable as constants.

---

## API Route Handler Conventions

**Request body parsing pattern:**
```typescript
let body: Body;
try {
  body = (await req.json()) as Body;
} catch {
  return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
}
```
Used consistently across all POST/PATCH handlers.

**Auth check pattern (all protected routes):**
```typescript
const tgUserId = req.headers.get('x-tma-user-id');
if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
```

**UUID validation pattern (routes with `[id]` params):**
```typescript
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UUID_RE.test(params.id)) {
  return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
}
```

**Error response shape:**
```typescript
{ error: string }           // single string code, snake_case
{ error: string, detail: string }  // with extra context
{ error: string, reason: string }  // with reason field
```
No consistent schema — `reason`, `detail`, `message` used interchangeably across routes.

**Success response shape:**
```typescript
{ agent: AgentRow }       // single entity
{ agents: AgentRow[] }    // collection
{ ok: true }              // action confirm
{ run_id: string, status: string }  // created entity with subset fields
```

**HTTP status codes used:**
- `200` — success
- `201` — resource created
- `202` — accepted (async agent run enqueue)
- `400` — bad request / validation error
- `401` — unauthorized
- `404` — not found
- `409` — conflict (sold out)
- `500` — internal server error
- `502` — upstream/external service error
- `503` — server misconfiguration (missing env)

**Route-level Next.js directives:**
- All API routes: `export const runtime = 'nodejs'` + `export const dynamic = 'force-dynamic'`
- Exception: `apps/tg-miniapp/app/api/tma/marketplace/route.ts` and `[slug]/route.ts` — missing `export const runtime = 'nodejs'` (will default to Edge runtime or auto, may cause issues with `postgres` package)

---

## TypeScript Strictness

**Base config** (`packages/typescript-config/base.json`):
- `"strict": true` — all strict mode flags enabled
- `"noUnusedLocals": true`, `"noUnusedParameters": true`
- `"noImplicitReturns": true`

**agent-worker override** (`apps/agent-worker/tsconfig.json`):
```json
"noUnusedLocals": false,
"noUnusedParameters": false
```
Explicitly disables two strict checks.

**Common type escape hatch — widespread `as unknown as T[]`:**
```typescript
const rows = (await sql`...`) as unknown as AgentRow[];
```
Used in every route file because `postgres` tagged templates return `postgres.RowList`, which is not assignable to typed arrays without casting. This is a known limitation, not a violation.

**`any` usage:**
- `apps/tg-miniapp/src/hooks/useAuth.ts:41` — `(window as any).Telegram?.WebApp` (unavoidable for Telegram SDK)
- `apps/tg-miniapp/src/hooks/useAuth.ts:52` — `(_err: any, val: string)` in CloudStorage callback (third-party callback type)

---

## Client vs. Server Component Split

All page components in `apps/tg-miniapp/app/` are **Client Components** (`'use client'`):
- `app/agents/page.tsx` — `'use client'`
- `app/agents/new/page.tsx` — `'use client'`
- `app/agents/[id]/page.tsx` — `'use client'`
- `app/profile/page.tsx` — `'use client'`
- `app/market/page.tsx` — likely client (fetches from API)
- `app/providers.tsx` — `'use client'` (TonConnect + Telegram SDK providers)

All API routes are Server Components by nature (no `'use client'`).

**Rationale:** TMA must access `window.Telegram.WebApp` on mount — Server Components are not viable for the auth flow. The entire page tree is effectively client-rendered.

---

## Import Organization

**Pattern in route files:**
1. Next.js framework (`next/server`)
2. External packages (`postgres`, `jose`, `bullmq`, `ioredis`, `@ton/core`)
3. Internal lib (`@/lib/...`, `@/hooks/...`, `@/components/...`)

No import sorting enforced by linter (no `.eslintrc` found in `apps/tg-miniapp/`).

**Path aliases** (from `apps/tg-miniapp/tsconfig.json`):
- `@/*` resolves to both `./app/*` and `./src/*`

---

## Error Handling

**API routes:**
- Parse errors: caught inline with `try/catch`, returns `{ error: 'invalid_json' }` 400
- DB errors: NOT caught in most routes — unhandled DB exceptions propagate as 500 with Next.js default error page. Only `marketplace/route.ts` and `nft/collections/route.ts` wrap in `try/catch`
- External service errors (TonCenter, Startonus, CoinGecko): explicitly caught with `502` response

**agent-worker:**
- Model call errors: caught, run marked as failed, user notified via Bot API
- Budget exceeded: explicit pre-run and mid-run guards
- Unhandled exceptions in `runAgent` would bubble to BullMQ and mark job failed (not explicitly caught at top level)

**Client (React pages):**
- Pattern: local `error` state strings, displayed inline as `<div className="tma-error">`
- No global error boundary in TMA pages

---

## Comments

**When used:**
- JSDoc on exported functions in utility files (`verify-init-data.ts`, `external-agent.ts`, `db.ts`)
- Inline explanations for non-obvious choices (SSRF guard rules, atomic-confirm logic, MVP stubs)
- `// MVP:` prefix marks known temporary shortcuts
- `// TODO:` marks deferred strict implementation (e.g. `ton-proof.ts:10`)

---

*Convention analysis: 2026-06-02*
