import { NextRequest } from 'next/server';
import { consumePlaygroundHit, refundPlaygroundHit } from './rate-limit';
import { getModelBySlug } from '@/lib/marketplace/catalog';

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

  // The public playground only exposes models from the generated storefront
  // catalog. Validate here as well so local fallback mode cannot accept an
  // arbitrary syntactically valid slug that production would later reject.
  if (!/^[a-z0-9_\-/.]+$/.test(modelSlug)) {
    return Response.json({ error: 'invalid_model_slug' }, { status: 400 });
  }
  if (!getModelBySlug(modelSlug)) {
    return Response.json({ error: 'model_not_found' }, { status: 404 });
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

  // 🔴 AG-7 (2026-09-30): this used to ask the gateway for `stream: true`.
  // The sold v1 contract pins `parameters.stream = { const: false }` and the
  // chat handler answers `unsupported_execution_contract` (501), so every
  // playground request failed while the page advertised "real model, same as
  // the API". It also omitted `Idempotency-Key`, which the contract requires.
  // Request the plain (non-streaming) completion and re-frame the single
  // assistant message as one delta — the browser-side SSE shape is unchanged.
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${systemKey}`,
        'x-aiag-playground': '1',
        'idempotency-key': `pg_${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        model: modelSlug,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
      }),
    });
  } catch {
    await refundPlaygroundHit(ip);
    return Response.json({ error: 'gateway_unreachable' }, { status: 502 });
  }

  if (!upstreamRes.ok) {
    await refundPlaygroundHit(ip);
    return Response.json({ error: `gateway_${upstreamRes.status}` }, { status: 502 });
  }

  let text: string;
  try {
    const payload = (await upstreamRes.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    text = typeof content === 'string' ? content : '';
  } catch {
    await refundPlaygroundHit(ip);
    return Response.json({ error: 'gateway_bad_response' }, { status: 502 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (text) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ delta: text })}\n\n`),
          );
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`),
        );
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
