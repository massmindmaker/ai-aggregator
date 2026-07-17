import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Alert, AlertDescription } from '@/components/ui/Alert';
import {
  getAllModels,
  getModelByOrgAndSlug,
  isForeignHosted,
  MODEL_TYPE_LABEL_RU,
} from '@/lib/marketplace/catalog';
import { formatPriceLabel } from '@/lib/marketplace/pricing-calc';
import { PlaygroundEmbed } from '@/components/marketplace/PlaygroundEmbed';
import { TransferWarningBadge } from '@/components/TransferWarningBadge';
import { auth } from '@/auth';

interface RouteParams {
  params: { org: string; model: string };
}

// This page reads the session (auth()), so it must render per-request, not
// be baked once by generateStaticParams below — otherwise every visitor
// (logged in or not) gets whichever auth state was true at build time.
export const dynamic = 'force-dynamic';

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
  if (!model) return { title: 'Playground — модель не найдена' };
  return {
    title: `Playground ${model.name} | AI Aggregator`,
    description: `Попробуйте ${model.name} прямо в браузере. Бесплатный демо-режим.`,
    robots: { index: false, follow: true },
    alternates: {
      canonical: `/marketplace/${params.org}/${params.model}/playground`,
    },
  };
}

export default async function PlaygroundPage({ params }: RouteParams) {
  const model = getModelByOrgAndSlug(params.org, params.model);
  if (!model) notFound();

  const foreign = isForeignHosted(model.orgSlug);
  const session = await auth();
  const isLoggedIn = Boolean(session?.user);

  return (
    <MainLayout>
      <section className="container mx-auto max-w-6xl px-4 py-6 md:py-10">
        <nav aria-label="Навигация" className="mb-4 text-sm">
          <Button variant="ghost" size="sm" asChild leftIcon={<ArrowLeft className="h-4 w-4" />}>
            <Link href={`/marketplace/${params.org}/${params.model}`}>
              К странице модели
            </Link>
          </Button>
        </nav>

        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
            Playground — {model.name}
          </h1>
          <p className="text-muted-foreground mt-1">
            {MODEL_TYPE_LABEL_RU[model.type]} от {model.orgName}. {formatPriceLabel(model)}
          </p>
        </header>

        {foreign && (
          <Alert className="mb-4">
            <AlertDescription className="flex items-center gap-2 flex-wrap">
              <TransferWarningBadge variant="chip" />
              <span>
                Модель размещена за пределами РФ. Не отправляйте персональные данные
                без отдельного согласия на трансграничную передачу.
              </span>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid lg:grid-cols-[1fr_280px] gap-6">
          <PlaygroundEmbed model={model} />

          <aside className="space-y-4">
            <Card>
              <CardContent className="p-4 text-sm space-y-2">
                <div className="font-semibold">Ограничения демо-режима</div>
                <ul className="list-disc ms-4 space-y-1 text-muted-foreground">
                  <li>
                    {isLoggedIn
                      ? '5 запросов в сутки — общий лимит демо-режима'
                      : '5 запросов в сутки без авторизации'}
                  </li>
                  <li>Ответы заранее заготовлены</li>
                  <li>Стриминг эмулирован</li>
                </ul>
                <p className="text-xs text-muted-foreground pt-2">
                  Это демо: ответы не идут через боевую модель. Реальная маршрутизация
                  подключится в одном из ближайших обновлений.
                </p>
              </CardContent>
            </Card>

            {!isLoggedIn && (
              <Card>
                <CardContent className="p-4 text-sm space-y-2">
                  <div className="font-semibold">Хотите больше?</div>
                  <p className="text-muted-foreground">
                    Зарегистрируйтесь и получите API-ключ — до 50 запросов/день.
                  </p>
                  <Button asChild size="sm" className="w-full">
                    <Link href="/register">Зарегистрироваться</Link>
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
