import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { getAllScenarios } from '@/lib/marketplace/scenarios';

export const metadata: Metadata = {
  title: 'Сценарии использования AI — AI Aggregator',
  description:
    'Готовые шаблоны промптов для типовых задач: поддержка, маркетинг, заметки встреч, генерация обложек, RAG. Подставьте данные — получите результат.',
  alternates: { canonical: '/marketplace/scenarios' },
};

// 🔴 AG-7 (2026-09-30): this legend carried a speech-recognition key, but
// transcription is not a modality any sold scenario has (`ScenarioModality` is
// chat|image|tts|embedding) and it was withdrawn from sale by migration
// 0093_depublish_stt_v1. The key could never match a rendered card.
const MODALITY_LABEL: Record<string, string> = {
  chat: 'Чат',
  image: 'Изображения',
  tts: 'Синтез речи',
  embedding: 'Эмбеддинги',
};

export default function ScenariosPage() {
  const scenarios = getAllScenarios();

  return (
    <MainLayout>
      <section className="container mx-auto max-w-5xl px-4 py-6 md:py-10">
        <Button
          variant="ghost"
          size="sm"
          asChild
          leftIcon={<ArrowLeft className="h-4 w-4" />}
          className="mb-4"
        >
          <Link href="/marketplace">Каталог моделей</Link>
        </Button>

        <header className="mb-8">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
            Сценарии использования
          </h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            Готовые шаблоны промптов для типовых задач. Нажмите «Открыть» —
            перейдёте на страницу модели с уже подставленным промптом.
          </p>
        </header>

        <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
          {scenarios.map((s) => (
            <Card key={s.slug} className="hover:border-primary/50 transition-colors">
              <CardContent className="p-5 flex flex-col gap-3 h-full">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-semibold">{s.title}</h2>
                  <Badge variant="secondary" className="shrink-0">
                    {MODALITY_LABEL[s.modality] ?? s.modality}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {s.shortDescription}
                </p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {s.tags.map((t) => (
                    <Badge key={t} variant="outline" className="text-[10px] h-5">
                      {t}
                    </Badge>
                  ))}
                </div>
                <div className="mt-auto pt-3 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    рекомендуем:{' '}
                    <code className="font-mono text-foreground/80">
                      {s.recommendedModelSlug}
                    </code>
                  </span>
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/marketplace/scenarios/${s.slug}`}>
                    Открыть
                    <ArrowRight className="h-3 w-3 ms-1" aria-hidden />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </MainLayout>
  );
}
