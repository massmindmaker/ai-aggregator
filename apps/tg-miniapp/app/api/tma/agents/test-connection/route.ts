import { NextRequest, NextResponse } from 'next/server';
import { validateExternalUrl } from '@/lib/url-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TestBody {
  base_url?: string;
  api_key?: string;
  model_slug?: string;
}

interface ProbeResult {
  ok: boolean;
  models_count?: number;
  sample_model?: string;
  latency_ms?: number;
  chat_ok?: boolean;
  reason?: string;
  detail?: string;
}

const TIMEOUT_MS = 8000;

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function POST(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: TestBody;
  try {
    body = (await req.json()) as TestBody;
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid_json' } satisfies ProbeResult, {
      status: 400,
    });
  }

  const urlCheck = validateExternalUrl(body.base_url ?? '');
  if (!urlCheck.ok || !urlCheck.normalised) {
    return NextResponse.json({
      ok: false,
      reason: `url_${urlCheck.reason ?? 'invalid'}`,
    } satisfies ProbeResult);
  }
  const baseUrl = urlCheck.normalised;
  const key = body.api_key?.trim();
  if (!key || key.length < 8) {
    return NextResponse.json({ ok: false, reason: 'api_key_required' } satisfies ProbeResult);
  }
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const t0 = Date.now();

  // 1. GET /models
  let modelsCount: number | undefined;
  let sampleModel: string | undefined;
  try {
    const r = await fetchWithTimeout(`${baseUrl}/models`, { headers }, TIMEOUT_MS);
    if (r.status === 401 || r.status === 403) {
      return NextResponse.json({
        ok: false,
        reason: 'auth_failed',
        detail: `HTTP ${r.status}`,
      } satisfies ProbeResult);
    }
    if (r.ok) {
      const j = (await r.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
      modelsCount = j?.data?.length;
      sampleModel = j?.data?.[0]?.id;
    }
    // non-200 here is non-fatal — some servers gate /models, chat probe will catch real problems
  } catch (e) {
    return NextResponse.json({
      ok: false,
      reason: 'models_unreachable',
      detail: (e as Error).message,
    } satisfies ProbeResult);
  }

  // 2. Tiny chat completion as the real liveness check.
  const model =
    (body.model_slug?.trim() ||
      sampleModel ||
      'gpt-4o-mini'); /* harmless default — most stacks accept it */
  let chatOk = false;
  try {
    const r = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 4,
        }),
      },
      TIMEOUT_MS,
    );
    if (r.status === 401 || r.status === 403) {
      return NextResponse.json({
        ok: false,
        reason: 'auth_failed',
        detail: `chat HTTP ${r.status}`,
      } satisfies ProbeResult);
    }
    if (r.status === 404) {
      return NextResponse.json({
        ok: false,
        reason: 'endpoint_not_found',
        detail: 'POST /chat/completions returned 404 — wrong base URL?',
      } satisfies ProbeResult);
    }
    chatOk = r.ok;
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return NextResponse.json({
        ok: false,
        reason: 'chat_failed',
        detail: `HTTP ${r.status}: ${txt.slice(0, 200)}`,
      } satisfies ProbeResult);
    }
  } catch (e) {
    return NextResponse.json({
      ok: false,
      reason: 'chat_unreachable',
      detail: (e as Error).message,
    } satisfies ProbeResult);
  }

  return NextResponse.json({
    ok: true,
    models_count: modelsCount,
    sample_model: sampleModel,
    latency_ms: Date.now() - t0,
    chat_ok: chatOk,
  } satisfies ProbeResult);
}
