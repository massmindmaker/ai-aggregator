import { NextRequest } from 'next/server';
import { consumePlaygroundHit, refundPlaygroundHit } from './rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Rate-limit: 5 free requests per IP per day, Redis-backed with a TTL to
// end-of-day (survives pm2 restarts — the old in-memory Map did not).
// 🔴 Fail-closed: an unresolved client IP is a REJECTION now, not a bypass
// (see guard.ts). This endpoint spends real upstream money on a shared
// system key, so "we can't identify the caller" must not mean "unlimited".
const FREE_LIMIT = 5;

interface RunRequest {
  model?: string;
  prompt?: string;
}

// Resolve client IP without trusting spoofable X-Forwarded-For first hop.
// Prefer X-Real-IP (set by our nginx with $remote_addr). Otherwise take the
// LAST IP in X-Forwarded-For (the nearest trusted proxy added it).
function getClientIp(req: NextRequest): string | null {
  const realIp = req.headers.get('x-real-ip');
  if (realIp && /^[\d.:a-f]+$/.test(realIp)) return realIp;

  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const ips = xff.split(',').map((s) => s.trim()).filter(Boolean);
    const last = ips[ips.length - 1];
    if (last && /^[\d.:a-f]+$/.test(last)) return last;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);

  // 🔴 P0 fix: an unresolved IP used to bypass the limit entirely
  // (`if (ip && ...)` short-circuited). Fail-closed instead.
  // Just `!ip` here — the actual quota decision (used vs limit) is made once,
  // atomically, inside `consumePlaygroundHit` below via `playgroundAllowed`;
  // calling `playgroundAllowed` a second time here with a hardcoded `used: 0`
  // would always be true for a truthy `ip` (0 < FREE_LIMIT) and was dead code.
  if (!ip) {
    return Response.json(
      { error: 'ip_unresolved', message: 'Не удалось определить источник запроса.' },
      { status: 403 }
    );
  }

  const { allowed } = await consumePlaygroundHit(ip, FREE_LIMIT);
  if (!allowed) {
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

  // Slug validation is enforced by the gateway (DB lookup) — no static catalog needed
  if (!/^[a-z0-9_\-/.]+$/.test(modelSlug)) {
    return Response.json({ error: 'invalid_model_slug' }, { status: 400 });
  }

  const gatewayUrl = process.env.GATEWAY_INTERNAL_URL ?? 'http://localhost:8787';
  const systemKey = process.env.GATEWAY_SYSTEM_API_KEY ?? '';

  if (!systemKey) {
    // In production, refuse rather than silently mock — missing key is a config error
    if (process.env.NODE_ENV === 'production') {
      return Response.json({ error: 'gateway_not_configured' }, { status: 503 });
    }
    return fallbackMock(modelSlug, prompt);
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
        model: modelSlug,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
      }),
    });
  } catch {
    await refundPlaygroundHit(ip);
    return Response.json({ error: 'gateway_unreachable' }, { status: 502 });
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    await refundPlaygroundHit(ip);
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
