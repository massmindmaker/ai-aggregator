import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Clock, Play, Code2, Shield } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { TransferWarningBadge } from '@/components/TransferWarningBadge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/Tabs';
import { Alert, AlertDescription } from '@/components/ui/Alert';
import {
  getAllModels,
  getModelByOrgAndSlug,
  findRelatedModels,
  isForeignHosted,
  MODEL_TYPE_LABEL_RU,
  type CatalogModel,
} from '@/lib/marketplace/catalog';
import { formatPriceLabel } from '@/lib/marketplace/pricing-calc';
import { ModelCard } from '@/components/marketplace/ModelCard';
import { CodeExampleTabs } from '@/components/marketplace/CodeExampleTabs';

interface RouteParams {
  params: { org: string; model: string };
}

export const revalidate = 300;
export const dynamicParams = true;

export async function generateStaticParams() {
  return getAllModels().map((m) => ({
    org: m.orgSlug,
    model: m.modelSlug,
  }));
}

export async function generateMetadata({
  params,
}: RouteParams): Promise<Metadata> {
  const model = getModelByOrgAndSlug(params.org, params.model);
  if (!model) {
    return { title: 'Модель не найдена — AI Aggregator' };
  }
  const title = `${model.name} API — ${model.orgName} | AI Aggregator`;
  return {
    title,
    description: model.shortDescription,
    openGraph: {
      title,
      description: model.shortDescription,
      type: 'article',
      ...(model.imageUrl ? { images: [model.imageUrl] } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: model.shortDescription,
      ...(model.imageUrl ? { images: [model.imageUrl] } : {}),
    },
    alternates: {
      canonical: `/marketplace/${params.org}/${params.model}`,
    },
  };
}

const TYPE_ABBR: Record<string, string> = {
  llm: 'LLM',
  image: 'IMG',
  audio: 'AUD',
  video: 'VID',
  embedding: 'EMB',
  code: 'CODE',
  'speech-to-text': 'STT',
  'text-to-speech': 'TTS',
  multimodal: 'MM',
};

function buildProductJsonLd(model: CatalogModel) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: model.name,
    description: model.description,
    brand: {
      '@type': 'Brand',
      name: model.orgName,
    },
    category: MODEL_TYPE_LABEL_RU[model.type],
    offers: {
      '@type': 'Offer',
      priceCurrency: 'RUB',
      price: model.pricing.inputPer1k ?? model.pricing.perImage ?? model.pricing.perMinute ?? model.pricing.perSecond ?? 0,
      availability: 'https://schema.org/InStock',
      url: `https://aiag.ru/marketplace/${model.orgSlug}/${model.modelSlug}`,
    },
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: model.stats.avgRating,
      reviewCount: model.stats.totalReviews,
      bestRating: 5,
      worstRating: 1,
    },
  };
}

export default function ModelDetailPage({ params }: RouteParams) {
  const model = getModelByOrgAndSlug(params.org, params.model);
  if (!model) notFound();

  const related = findRelatedModels(model, 4);
  const foreign = isForeignHosted(model.orgSlug);
  const ruHosted = model.hostingRegion === 'ru';
  const jsonLd = buildProductJsonLd(model);

  return (
    <MainLayout>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <section className="container mx-auto max-w-7xl px-4 py-6 md:py-10">
        {/* Breadcrumb */}
        <nav aria-label="Хлебные крошки" className="mb-4 text-sm">
          <ol className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <li>
              <Link href="/marketplace" className="hover:text-foreground inline-flex items-center gap-1">
                <ArrowLeft className="h-3 w-3" aria-hidden />
                Каталог
              </Link>
            </li>
            <li aria-hidden>/</li>
            <li>{model.orgName}</li>
            <li aria-hidden>/</li>
            <li className="text-foreground">{model.name}</li>
          </ol>
        </nav>

        {/* Header */}
        <header className="mb-6">
          <div className="flex items-start gap-4">
            <span
              aria-hidden
              className="shrink-0 inline-flex items-center justify-center px-2.5 h-10 rounded-sm font-mono font-semibold text-[11px] tracking-wider"
              style={{
                background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
                color: 'var(--accent)',
                border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)',
              }}
              title={MODEL_TYPE_LABEL_RU[model.type]}
            >
              {TYPE_ABBR[model.type]}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
                  {model.name}
                </h1>
                <Badge variant="secondary">{MODEL_TYPE_LABEL_RU[model.type]}</Badge>
                {ruHosted && (
                  <Badge
                    variant="secondary"
                    className="gap-1 bg-emerald-500/15 text-emerald-500 border-emerald-500/20"
                  >
                    <Shield className="h-3 w-3" aria-hidden />
                    Хостинг РФ
                  </Badge>
                )}
                {foreign && <TransferWarningBadge />}
              </div>
              <p className="text-sm text-muted-foreground">
                от{' '}
                <span className="text-foreground font-medium">{model.orgName}</span>
                {' · '}
                <code className="font-mono text-xs">{model.slug}</code>
              </p>
              <p className="mt-3 text-foreground/90 max-w-2xl">
                {model.shortDescription}
              </p>
            </div>
          </div>
        </header>

        <div className="grid lg:grid-cols-[1fr_320px] gap-8">
          {/* Main content */}
          <div className="min-w-0 space-y-6">
            <Tabs defaultValue="overview">
              <TabsList>
                <TabsTrigger value="overview">Обзор</TabsTrigger>
                <TabsTrigger value="api">
                  <Code2 className="h-4 w-4 me-1" aria-hidden />
                  API
                </TabsTrigger>
                <TabsTrigger value="pricing">
                  <Clock className="h-4 w-4 me-1" aria-hidden />
                  Цены
                </TabsTrigger>
                <TabsTrigger value="specs">Спеки</TabsTrigger>
              </TabsList>

              <TabsContent value="overview">
                <Card>
                  <CardContent className="p-6 space-y-4">
                    <p className="leading-relaxed text-foreground/90">
                      {model.description}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {model.tags.map((t) => (
                        <Badge key={t} variant="outline">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="api">
                <Card>
                  <CardContent className="p-6">
                    <h2 className="text-lg font-semibold mb-4">
                      Быстрый старт
                    </h2>
                    <p className="text-sm text-muted-foreground mb-4">
                      Используйте единый API AI Aggregator. Замените{' '}
                      <code className="font-mono text-xs">$AIAG_API_KEY</code> на
                      свой ключ.
                    </p>
                    <CodeExampleTabs model={model} />
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="pricing">
                <Card>
                  <CardContent className="p-6 space-y-4">
                    <h2 className="text-lg font-semibold">Тарификация</h2>
                    <p className="font-mono text-foreground">
                      {formatPriceLabel(model)}
                    </p>
                    <Alert>
                      <AlertDescription>
                        Цены указаны с учётом наценки шлюза 15%. Оплата в рублях
                        с баланса — без комиссии банка и VPN.
                      </AlertDescription>
                    </Alert>
                    <Button variant="outline" asChild>
                      <Link href="/pricing">Подробно о тарифах</Link>
                    </Button>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="specs">
                <Card>
                  <CardContent className="p-6">
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                      <SpecRow label="Регион хостинга" value={model.hostingRegion.toUpperCase()} />
                      {model.capabilities.contextWindow && (
                        <SpecRow
                          label="Контекст"
                          value={`${model.capabilities.contextWindow.toLocaleString('ru-RU')} токенов`}
                        />
                      )}
                      {model.capabilities.maxOutputTokens && (
                        <SpecRow
                          label="Макс. output"
                          value={`${model.capabilities.maxOutputTokens.toLocaleString('ru-RU')} токенов`}
                        />
                      )}
                      <SpecRow
                        label="Streaming"
                        value={model.capabilities.streaming ? 'да' : 'нет'}
                      />
                      <SpecRow
                        label="Tool-calling"
                        value={model.capabilities.tools ? 'да' : 'нет'}
                      />
                      <SpecRow
                        label="Vision"
                        value={model.capabilities.vision ? 'да' : 'нет'}
                      />
                      <SpecRow
                        label="JSON schema"
                        value={model.capabilities.jsonSchema ? 'да' : 'нет'}
                      />
                      <SpecRow
                        label="p50 latency"
                        value={`${model.stats.p50LatencyMs} ms`}
                      />
                      <SpecRow
                        label="Uptime"
                        value={`${model.stats.uptimePct}%`}
                      />
                    </dl>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>

            {related.length > 0 && (
              <section>
                <h2 className="text-lg font-semibold mb-3">Похожие модели</h2>
                <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
                  {related.map((m) => (
                    <ModelCard key={m.slug} model={m} />
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* Sticky sidebar */}
          <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
            <Card>
              <CardContent className="p-5 space-y-3">
                <h2 className="text-sm font-semibold text-muted-foreground">
                  Цена
                </h2>
                <div className="font-mono text-lg">
                  {formatPriceLabel(model)}
                </div>
                <Button asChild className="w-full">
                  <Link href={`/marketplace/${model.orgSlug}/${model.modelSlug}/playground`}>
                    <Play className="h-4 w-4 me-1" aria-hidden />
                    Попробовать в Playground
                  </Link>
                </Button>
                <Button variant="outline" asChild className="w-full">
                  <Link href="/dashboard">
                    <Code2 className="h-4 w-4 me-1" aria-hidden />
                    Получить API ключ
                  </Link>
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Рейтинг</span>
                  <span className="font-medium">
                    {model.stats.avgRating.toFixed(1)} ({model.stats.totalReviews})
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Запросов / нед.</span>
                  <span className="font-medium">
                    {model.stats.weeklyRequests.toLocaleString('ru-RU')}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Uptime</span>
                  <span className="font-medium">{model.stats.uptimePct}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">p50 latency</span>
                  <span className="font-medium">
                    {model.stats.p50LatencyMs} ms
                  </span>
                </div>
              </CardContent>
            </Card>

            {ruHosted && (
              <Card>
                <CardContent className="p-5">
                  <div className="flex items-start gap-2">
                    <Shield className="h-5 w-5 text-emerald-500 shrink-0" aria-hidden />
                    <div className="text-sm">
                      <div className="font-semibold text-emerald-500">
                        Shield-RF: хостинг в РФ
                      </div>
                      <p className="text-muted-foreground mt-1">
                        Модель размещена на территории РФ. Трансграничная
                        передача ПД не требуется (152-ФЗ).
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {foreign && (
              <Card>
                <CardContent className="p-5 space-y-2 text-sm">
                  <div className="font-semibold">Внимание</div>
                  <p className="text-muted-foreground">
                    Эта модель размещена за пределами РФ. При передаче
                    персональных данных требуется отдельное согласие на
                    трансграничную передачу (152-ФЗ, ст. 12).
                  </p>
                  <Button variant="outline" size="sm" asChild>
                    <Link href="/privacy#transborder">Подробнее</Link>
                  </Button>
                </CardContent>
              </Card>
            )}
          </aside>
        </div>
      </section>
    </MainLayout>
  );
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-border/50 pb-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
