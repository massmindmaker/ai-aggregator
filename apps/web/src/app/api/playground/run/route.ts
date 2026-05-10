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
  // Evict expired entries to prevent unbounded growth
  if (ipHits.size > 10_000) {
    for (const [k, v] of ipHits) {
      if (v.resetAt < now) ipHits.delete(k);
    }
  }
  const entry = ipHits.get(ip);
  if (!entry || entry.resetAt < now) {
    ipHits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= FREE_LIMIT) return false;
  entry.count++;
  return true;
}

function decrementRateLimit(ip: string): void {
  const entry = ipHits.get(ip);
  if (entry && entry.count > 0) entry.count--;
}

interface RunRequest {
  model?: string;
  prompt?: string;
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (ip && !checkRateLimit(ip)) {
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
  } catch {
    if (ip) decrementRateLimit(ip);
    return Response.json({ error: 'gateway_unreachable' }, { status: 502 });
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    if (ip) decrementRateLimit(ip);
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
