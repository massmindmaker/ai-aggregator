import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { MonogramAvatar } from '@/components/agentmarket/AgentTemplateCard';
import {
  getPublicAgentTemplateById,
  priceLabel,
} from '@/lib/agentmarket/catalog';

// Public bot entry point (@aiaggbot — the product's Telegram bot, not a
// personal account). The startapp param is a forward-compatible deep-link
// hint only; W1 does not implement launch/run, it just opens Telegram.
const TG_BOT_URL = 'https://t.me/aiaggbot';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: RouteParams): Promise<Metadata> {
  const { id } = await params;
  const template = await getPublicAgentTemplateById(id);
  if (!template) {
    return { title: 'Агент не найден — AI Aggregator' };
  }
  const name = template.name ?? 'Агент';
  return {
    title: `${name} — AI Aggregator`,
    description: template.description ?? undefined,
    alternates: { canonical: `/agentmarket/${id}` },
  };
}

export default async function AgentMarketDetailPage({ params }: RouteParams) {
  // HIDDEN (2026-07-15, founder decision): see page.tsx one level up and
  // docs/specs/2026-07-15-agentmarket-web-hidden.md — hard 404, code kept.
  // `as boolean` (not a literal `true`) so TS doesn't treat everything below
  // as statically unreachable — that would drop control-flow narrowing on
  // `template` further down (`if (!template) notFound()` → non-null) and
  // spuriously break the build.
  const AGENTMARKET_HIDDEN = true as boolean;
  if (AGENTMARKET_HIDDEN) notFound();

  const { id } = await params;
  const template = await getPublicAgentTemplateById(id);
  if (!template) notFound();

  const name = template.name ?? 'Без названия';
  const rating =
    template.avg_rating !== null ? Number(template.avg_rating) : null;
  const tools = Array.isArray(template.tools)
    ? (template.tools as unknown[])
    : [];
  const openInTelegramHref = `${TG_BOT_URL}?startapp=agent_${template.id}`;

  return (
    <MainLayout>
      <section className="container mx-auto max-w-4xl px-4 py-6 md:py-10">
        {/* Breadcrumb */}
        <nav aria-label="Хлебные крошки" className="mb-4 text-sm">
          <Link
            href="/agentmarket"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden />
            Витрина агентов
          </Link>
        </nav>

        {/* Header */}
        <header className="mb-6 flex items-start gap-4">
          <MonogramAvatar id={template.id} name={template.name} size={16} />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              {name}
            </h1>
            {template.trait && (
              <p className="text-sm text-muted-foreground mt-1">
                {template.trait}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 mt-2 text-sm text-muted-foreground">
              {template.author_username && (
                <span>от @{template.author_username}</span>
              )}
              {rating !== null && (
                <span>
                  ★ {rating.toFixed(1)} ({template.rating_count})
                </span>
              )}
            </div>
          </div>
        </header>

        {template.description && (
          <Card className="mb-6">
            <CardContent className="p-6">
              <p className="leading-relaxed text-foreground/90">
                {template.description}
              </p>
            </CardContent>
          </Card>
        )}

        <div className="grid sm:grid-cols-2 gap-4 mb-6">
          <Card>
            <CardContent className="p-5 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Модель</span>
                <span className="font-mono">
                  {template.model_slug ?? '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Цена</span>
                <span className="font-mono text-amber-500">
                  {priceLabel(template.price_credits)}
                </span>
              </div>
            </CardContent>
          </Card>

          {tools.length > 0 && (
            <Card>
              <CardContent className="p-5">
                <h2 className="text-sm font-semibold text-muted-foreground mb-2">
                  Инструменты
                </h2>
                <div className="flex flex-wrap gap-1.5">
                  {tools.slice(0, 12).map((tool, i) => (
                    <Badge
                      key={i}
                      variant="outline"
                      className="text-[11px] font-mono"
                    >
                      {typeof tool === 'string' ? tool : JSON.stringify(tool)}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <Button asChild size="lg">
          <a href={openInTelegramHref} target="_blank" rel="noopener noreferrer">
            Открыть в Telegram
          </a>
        </Button>
      </section>
    </MainLayout>
  );
}
