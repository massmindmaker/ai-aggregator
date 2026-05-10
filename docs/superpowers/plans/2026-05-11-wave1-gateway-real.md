# Wave 1 — Real Gateway + Ollama Adapter + Playground Wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mock playground responses with real LLM calls through `packages/api-gateway` via OpenRouter, Kie.ai, and Ollama Cloud.

**Architecture:** The gateway (`packages/api-gateway`) already has OpenRouter + Kie adapters. We add Ollama Cloud adapter, then rewire `apps/web/src/app/api/playground/run/route.ts` to proxy to the internal gateway instead of returning a mock. The gateway reads `OPENROUTER_API_KEY` / `KIE_API_KEY` / `OLLAMA_CLOUD_URL` from env.

**Tech Stack:** Hono (gateway), Next.js Route Handler (proxy), TypeScript, Bun, pm2 on VPS

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `packages/api-gateway/src/upstreams/ollama.ts` | Ollama Cloud adapter |
| Modify | `packages/api-gateway/src/upstreams/registry.ts` | Register ollama provider |
| Modify | `apps/web/src/app/api/playground/run/route.ts` | Replace mock with real gateway proxy |
| Modify | `apps/web/src/env.ts` or `apps/web/src/app/api/playground/run/route.ts` | Read `GATEWAY_INTERNAL_URL` from env |

---

## Task 1: Ollama Cloud adapter

**Files:**
- Create: `packages/api-gateway/src/upstreams/ollama.ts`
- Modify: `packages/api-gateway/src/upstreams/registry.ts`
- Test: `packages/api-gateway/src/__tests__/upstream-mock.test.ts` (extend)

- [ ] **Step 1: Write the adapter**

```typescript
// packages/api-gateway/src/upstreams/ollama.ts
/**
 * Ollama Cloud upstream — OpenAI-compatible /chat/completions endpoint.
 * Reads OLLAMA_CLOUD_URL and OLLAMA_CLOUD_API_KEY from env.
 */
import type { UpstreamAdapter, ChatRequest, ChatResponse } from './interface';
import { logger } from '../lib/logger';

function getBaseUrl(): string {
  return process.env.OLLAMA_CLOUD_URL ?? 'https://api.ollama.ai';
}

export const ollamaUpstream: UpstreamAdapter = {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const baseUrl = getBaseUrl();
    const apiKey = req.byokKey ?? process.env.OLLAMA_CLOUD_API_KEY;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

    // Ollama Cloud is OpenAI-compatible — use /v1/chat/completions, not /api/chat
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.modelId,
        messages: req.messages,
        stream: false,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: txt }, 'ollama_chat_error');
      throw new Error(`Ollama ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      id: `ollama-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: req.modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: data.choices?.[0]?.message?.content ?? '' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        completion_tokens: data.usage?.completion_tokens ?? 0,
        total_tokens: (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0),
      },
    };
  },

  async embeddings() {
    throw new Error('Ollama Cloud embeddings not implemented');
  },
};
```

- [ ] **Step 2: Register in registry**

In `packages/api-gateway/src/upstreams/registry.ts`, add after the `kie` case:

```typescript
import { ollamaUpstream } from './ollama';

// inside getUpstream switch:
case 'ollama':
  return process.env.OLLAMA_CLOUD_URL ? ollamaUpstream : mockUpstream;
```

- [ ] **Step 3: Run existing tests to verify nothing broke**

```bash
cd packages/api-gateway && bun test --timeout 10000
```
Expected: all tests pass (registry test might need updating for the new case — fix if it does).

- [ ] **Step 4: Commit**

```bash
git add packages/api-gateway/src/upstreams/ollama.ts packages/api-gateway/src/upstreams/registry.ts
git commit -m "feat(gateway): add Ollama Cloud upstream adapter"
```

---

## Task 2: Replace playground mock with real gateway proxy

**Files:**
- Modify: `apps/web/src/app/api/playground/run/route.ts`

The playground UI (`PlaygroundEmbed`) already calls `/api/playground/run` and reads SSE `{ delta: string }` events. We just need to replace the mock implementation with a real proxy to the internal gateway.

The internal gateway runs at `GATEWAY_INTERNAL_URL` (e.g. `http://127.0.0.1:8787` on VPS, or `http://localhost:8787` locally). The web server calls the gateway with a system API key from `GATEWAY_SYSTEM_API_KEY`.

- [ ] **Step 1: Write the real proxy**

Replace the entire contents of `apps/web/src/app/api/playground/run/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { getModelBySlug } from '@/lib/marketplace/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Rate-limit: 5 free requests per IP per day (tracked in-memory, resets on restart).
// For production, move to Redis. Sufficient for playground launch.
const ipHits = new Map<string, { count: number; resetAt: number }>();
const FREE_LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || entry.resetAt < now) {
    ipHits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= FREE_LIMIT) return false;
  entry.count++;
  return true;
}

interface RunRequest {
  model?: string;
  prompt?: string;
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(ip)) {
    return Response.json(
      { error: 'rate_limit', message: 'Лимит: 5 запросов в день для гостей. Зарегистрируйтесь для полного доступа.' },
      { status: 429 }
    );
  }

  let body: RunRequest;
  try {
    body = (await req.json()) as RunRequest;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const modelSlug = (body.model ?? '').trim();
  const prompt = (body.prompt ?? '').trim();
  if (!modelSlug) return Response.json({ error: 'model_required' }, { status: 400 });
  if (!prompt) return Response.json({ error: 'prompt_required' }, { status: 400 });

  const model = getModelBySlug(modelSlug);
  if (!model) return Response.json({ error: 'model_not_found' }, { status: 404 });

  const gatewayUrl = process.env.GATEWAY_INTERNAL_URL ?? 'http://localhost:8787';
  const systemKey = process.env.GATEWAY_SYSTEM_API_KEY ?? '';

  if (!systemKey) {
    // In production, refuse rather than silently mock — missing key is a config error
    if (process.env.NODE_ENV === 'production') {
      return Response.json({ error: 'gateway_not_configured' }, { status: 503 });
    }
    return fallbackMock(model.name, prompt);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${systemKey}`,
        'x-aiag-playground': '1',
      },
      body: JSON.stringify({
        model: model.slug,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
      }),
    });
  } catch (err) {
    return Response.json({ error: 'gateway_unreachable' }, { status: 502 });
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    return Response.json({ error: `gateway_${upstreamRes.status}` }, { status: 502 });
  }

  // Stream SSE from gateway → client in our delta format
  const encoder = new TextEncoder();
  const upstreamBody = upstreamRes.body;
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstreamBody.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') continue;
            try {
              const chunk = JSON.parse(raw);
              const delta = chunk?.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
              }
            } catch { /* skip malformed */ }
          }
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

// Fallback mock when gateway keys not configured (local dev)
function fallbackMock(modelName: string, prompt: string): Response {
  const text = `[Dev mode — gateway not configured] Mock ответ от ${modelName}. Запрос: "${prompt.slice(0, 60)}"`;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < text.length; i += 12) {
        const delta = text.slice(i, i + 12);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
        await new Promise(r => setTimeout(r, 40));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd apps/web && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors in the playground route file.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/playground/run/route.ts
git commit -m "feat(playground): wire real gateway SSE proxy, IP rate-limit 5req/day"
```

---

## Task 3: VPS environment keys (Human Gate 🔑)

> **Security note:** The gateway listens on port 8787 bound to `127.0.0.1` only (firewalled, not exposed to internet). Web app calls it via `GATEWAY_INTERNAL_URL=http://127.0.0.1:8787`. Never expose 8787 in UFW or nginx.


**This task requires manual action — cannot be automated.**

- [ ] **Step 1: SSH to VPS and add env vars**

```bash
ssh aiag-vps
nano /srv/aiag/shared/.env
```

Add the following lines (get values from your provider dashboards):
```
OPENROUTER_API_KEY=sk-or-v1-...
KIE_API_KEY=...
OLLAMA_CLOUD_URL=https://...
OLLAMA_CLOUD_API_KEY=...
GATEWAY_SYSTEM_API_KEY=sk_aiag_system_...   # generate: openssl rand -hex 32
```

- [ ] **Step 2: Add GATEWAY_INTERNAL_URL and GATEWAY_SYSTEM_API_KEY to web app env**

```bash
# On VPS, in the web app env section:
GATEWAY_INTERNAL_URL=http://127.0.0.1:8787
GATEWAY_SYSTEM_API_KEY=<same value as above>
```

- [ ] **Step 3: Confirm keys saved and reload pm2**

```bash
pm2 restart aiag-gateway --update-env
pm2 restart aiag-web --update-env
pm2 status
```
Expected: both `aiag-gateway` and `aiag-web` show `online`.

---

## Task 4: Deploy and smoke test

- [ ] **Step 1: Push and deploy from local**

```bash
git push origin master
# Wait for GitHub Actions CI, then:
ssh aiag-vps "cd /srv/aiag/current && pm2 status"
```
Or use manual deploy:
```bash
ops/scripts/deploy.sh
```

- [ ] **Step 2: Smoke test gateway directly on VPS**

```bash
ssh aiag-vps
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_SYSTEM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"Reply with just: OK"}],"stream":false}' \
  | head -c 500
```
Expected: JSON with `choices[0].message.content` containing "OK". Not a mock response.

- [ ] **Step 3: Smoke test playground via web**

Open `https://ai-aggregator.ru/marketplace/openai/gpt-4o-mini/playground`
Send message: "Ответь только: РАБОТАЕТ"
Expected: real streamed response (not the mock text about "Plan 04 gateway").

- [ ] **Step 4: Commit smoke test result (no code change needed)**

If everything works:
```bash
# Document in HANDOFF.json or just note it — nothing to commit here
echo "Wave 1 complete: real gateway connected at $(date)"
```
