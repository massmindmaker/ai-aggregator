import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  gatewayRequests,
  upstreams,
  incidents,
} from '@aiag/database/schema';
import { and, eq, gte, isNull, sql } from '@aiag/database';

/**
 * Plan 08 Task 12 — Live upstream health JSON для /status page.
 *
 * Реальные метрики: success rate + p95 latency per provider за последний час,
 * посчитанные из таблицы `requests` (gatewayRequests), сгруппированной по
 * provider через join с `upstreams`. Плюс активные/недавние инциденты из
 * таблицы `incidents`. Результат кэшируется ~30s в памяти процесса.
 *
 * Ops note: требует DATABASE_URL на VPS (есть в /srv/aiag/shared/.env). При
 * отсутствии БД или ошибке отдаёт graceful fallback (operational / пусто).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 30;

// Известные провайдеры — гарантируем, что они присутствуют в ответе даже без
// трафика за последний час (показываем как operational с null success/p95).
// Внутренние ключи маршрутизации (см. `upstreams.provider` в БД) — НЕ отдаём
// их наружу как есть. Публичные модели-бренды (OpenAI/Anthropic/Yandex/
// GigaChat) можно показывать как есть — это не upstream-роутинг, это витрина
// самого продукта. Роутинг-брокеры (fal/kie/together/...) — white-label:
// см. SECURITY.md, никогда не показываем брокера конечному пользователю.
const KNOWN_PROVIDERS = [
  'openai',
  'anthropic',
  'yandex',
  'gigachat',
  'fal',
  'kie',
  'together',
];

// Публичная (обезличенная) метка для внутреннего ключа роутинга. Брокеры,
// через которых мы физически ходим к апстриму, никогда не показываются под
// своим именем — только под нашим собственным названием канала.
const PROVIDER_PUBLIC_LABEL: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  yandex: 'yandex',
  gigachat: 'gigachat',
  fal: 'media-channel-a',
  kie: 'media-channel-b',
  together: 'open-models-channel',
};

// Safety net for any future `upstreams.provider` value that isn't in the map
// above yet: known routing-broker name fragments are redacted by default so
// a new broker can never leak its brand before someone adds a proper label.
const KNOWN_BROKER_FRAGMENTS = ['kie', 'fal', 'together', 'replicate', 'openrouter', 'gonka', 'hf', 'tg-bridge'];

function toPublicProviderLabel(provider: string): string {
  const mapped = PROVIDER_PUBLIC_LABEL[provider];
  if (mapped) return mapped;
  const lower = provider.toLowerCase();
  if (KNOWN_BROKER_FRAGMENTS.some((f) => lower.includes(f))) return 'other-channel';
  return provider;
}

type ProviderStatus = {
  provider: string;
  status: 'operational' | 'degraded' | 'down';
  successRate: number | null;
  p95TtftMs: number | null;
};

type StatusPayload = {
  providers: ProviderStatus[];
  activeIncidents: Array<{
    id: string;
    title: string;
    status: string;
    impact: string;
    startedAt: string;
  }>;
  recentIncidents: Array<{
    id: string;
    title: string;
    status: string;
    startedAt: string;
    resolvedAt: string | null;
  }>;
  generatedAt: string;
};

// --- in-process cache (~30s) -------------------------------------------------
let cache: { at: number; payload: StatusPayload } | null = null;
const CACHE_TTL_MS = 30_000;

function classify(successRate: number | null): ProviderStatus['status'] {
  if (successRate === null) return 'operational';
  if (successRate >= 0.98) return 'operational';
  if (successRate >= 0.85) return 'degraded';
  return 'down';
}

async function computeStatus(): Promise<StatusPayload> {
  const now = new Date();
  const since = new Date(now.getTime() - 60 * 60 * 1000); // last 1h

  // Success rate + p95 latency per provider over the last hour.
  // join requests → upstreams to resolve provider name.
  const rows = await db
    .select({
      provider: upstreams.provider,
      total: sql<number>`COUNT(*)::int`,
      success: sql<number>`COUNT(*) FILTER (WHERE ${gatewayRequests.statusCode} >= 200 AND ${gatewayRequests.statusCode} < 400)::int`,
      p95: sql<number | null>`PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${gatewayRequests.latencyMs})`,
    })
    .from(gatewayRequests)
    .innerJoin(upstreams, eq(gatewayRequests.upstreamId, upstreams.id))
    .where(gte(gatewayRequests.createdAt, since))
    .groupBy(upstreams.provider);

  const byProvider = new Map<
    string,
    { total: number; success: number; p95: number | null }
  >();
  for (const r of rows) {
    byProvider.set(r.provider, {
      total: r.total,
      success: r.success,
      p95: r.p95 === null ? null : Math.round(Number(r.p95)),
    });
  }

  // Union of known providers + any provider that actually saw traffic.
  const providerNames = new Set<string>([...KNOWN_PROVIDERS, ...byProvider.keys()]);

  const providers: ProviderStatus[] = [...providerNames].sort().map((provider) => {
    const agg = byProvider.get(provider);
    if (!agg || agg.total === 0) {
      return {
        provider: toPublicProviderLabel(provider),
        status: 'operational',
        successRate: null,
        p95TtftMs: null,
      };
    }
    const successRate = agg.success / agg.total;
    return {
      provider: toPublicProviderLabel(provider),
      status: classify(successRate),
      successRate: Number(successRate.toFixed(4)),
      p95TtftMs: agg.p95,
    };
  });

  // Active incidents (not yet resolved).
  const active = await db
    .select({
      id: incidents.id,
      title: incidents.title,
      status: incidents.status,
      impact: incidents.impact,
      startedAt: incidents.startedAt,
    })
    .from(incidents)
    .where(and(isNull(incidents.resolvedAt), sql`${incidents.status} <> 'resolved'`))
    .orderBy(sql`${incidents.startedAt} DESC`)
    .limit(20);

  // Recent incidents (last 7 days, includes resolved).
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const recent = await db
    .select({
      id: incidents.id,
      title: incidents.title,
      status: incidents.status,
      startedAt: incidents.startedAt,
      resolvedAt: incidents.resolvedAt,
    })
    .from(incidents)
    .where(gte(incidents.startedAt, sevenDaysAgo))
    .orderBy(sql`${incidents.startedAt} DESC`)
    .limit(20);

  return {
    providers,
    activeIncidents: active.map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      impact: i.impact,
      startedAt: i.startedAt.toISOString(),
    })),
    recentIncidents: recent.map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      startedAt: i.startedAt.toISOString(),
      resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
    })),
    generatedAt: now.toISOString(),
  };
}

function fallback(): StatusPayload {
  return {
    providers: KNOWN_PROVIDERS.map((provider) => ({
      provider: toPublicProviderLabel(provider),
      status: 'operational' as const,
      successRate: null,
      p95TtftMs: null,
    })),
    activeIncidents: [],
    recentIncidents: [],
    generatedAt: new Date().toISOString(),
  };
}

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json(cache.payload);
  }

  try {
    const payload = await computeStatus();
    cache = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch {
    // DB unavailable (no DATABASE_URL at build/preview, transient error, etc.)
    // — degrade gracefully without leaking internals.
    return NextResponse.json(fallback());
  }
}
