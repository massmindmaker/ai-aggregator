import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Copy } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import {
  getAllScenarios,
  getScenarioBySlug,
} from '@/lib/marketplace/scenarios';
import { getModelBySlug } from '@/lib/marketplace/catalog';
import { isChatRunnable } from '@/lib/marketplace/sold-contract';
import { CopyButton } from '@/components/marketplace/CopyButton';

interface Params {
  params: Promise<{ scenario: string }>;
}

export async function generateStaticParams() {
  return getAllScenarios().map((s) => ({ scenario: s.slug }));
}

export async function generateMetadata({
  params: paramsPromise,
}: Params): Promise<Metadata> {
  const params = await paramsPromise;
  const s = getScenarioBySlug(params.scenario);
  if (!s) return { title: 'Сценарий не найден' };
  return {
    title: `${s.title} — сценарий | AI Aggregator`,
    description: s.shortDescription,
    alternates: {
      canonical: `/marketplace/scenarios/${s.slug}`,
    },
  };
}

export default async function ScenarioDetailPage({ params: paramsPromise }: Params) {
  const params = await paramsPromise;
  const scenario = getScenarioBySlug(params.scenario);
  if (!scenario) notFound();

  const model = getModelBySlug(scenario.recommendedModelSlug);

  return (
    <MainLayout>
      <section className="container mx-auto max-w-4xl px-4 py-6 md:py-10">
        <Button
          variant="ghost"
          size="sm"
          asChild
          leftIcon={<ArrowLeft className="h-4 w-4" />}
          className="mb-4"
        >
          <Link href="/marketplace/scenarios">Все сценарии</Link>
        </Button>

        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
            {scenario.title}
          </h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            {scenario.longDescription}
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            {scenario.tags.map((t) => (
              <Badge key={t} variant="outline">
                {t}
              </Badge>
            ))}
          </div>
        </header>

        <div className="grid lg:grid-cols-[1fr_280px] gap-6">
          <div className="space-y-4 min-w-0">
            <Card>
              <CardContent className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold">Промпт</h2>
                  <CopyButton text={scenario.prompt} />
                </div>
                <pre className="bg-secondary rounded-md p-4 text-sm font-mono whitespace-pre-wrap break-words">
                  {scenario.prompt}
                </pre>
              </CardContent>
            </Card>
          </div>

          <aside className="space-y-4">
            {model ? (
              <Card>
                <CardContent className="p-4 space-y-2 text-sm">
                  <div className="text-muted-foreground text-xs">
                    Рекомендуемая модель
                  </div>
                  <div className="font-semibold">{model.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {model.orgName}
                  </div>
                  {/* 🔴 AG-7: the playground posts to /v1/chat/completions, so
                      it can only run chat models. Offering it for the image /
                      embedding / tts scenarios was a guaranteed failure. */}
                  {isChatRunnable(model.type) ? (
                    <Button asChild size="sm" className="w-full mt-2">
                      <Link
                        href={`/marketplace/${model.orgSlug}/${model.modelSlug}/playground`}
                      >
                        <Copy className="h-3 w-3 me-1" aria-hidden />
                        Открыть в Playground
                      </Link>
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-2">
                      Этот сценарий выполняется собственным эндпоинтом модели,
                      а не через чат — в Playground его запустить нельзя.
                    </p>
                  )}
                  <Button asChild size="sm" variant="outline" className="w-full">
                    <Link href={`/marketplace/${model.orgSlug}/${model.modelSlug}`}>
                      Страница модели
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-4 text-sm text-muted-foreground">
                  Рекомендуемая модель ({scenario.recommendedModelSlug}) пока
                  недоступна в каталоге.
                </CardContent>
              </Card>
            )}
          </aside>
        </div>
      </section>
    </MainLayout>
  );
}
