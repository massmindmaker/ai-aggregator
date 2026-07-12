import type { Metadata } from 'next';
import MainLayout from '@/components/layout/MainLayout';
import { AgentTemplateGrid } from '@/components/agentmarket/AgentTemplateCard';
import { getPublicAgentTemplates } from '@/lib/agentmarket/catalog';

export const metadata: Metadata = {
  title: 'Витрина агентов — AI Aggregator',
  description:
    'Публичная витрина AI-агентов сообщества: персонажи, модели, инструменты. Откройте агента в Telegram.',
  openGraph: {
    title: 'Витрина агентов — AI Aggregator',
    description:
      'Публичная витрина AI-агентов сообщества. Откройте агента в Telegram.',
    type: 'website',
  },
  alternates: { canonical: '/agentmarket' },
};

export const dynamic = 'force-dynamic';

export default async function AgentMarketPage() {
  const templates = await getPublicAgentTemplates();

  return (
    <MainLayout>
      <section className="aiag-grid-bg-sm container mx-auto max-w-7xl px-4 py-8 md:py-12">
        <header className="mb-6 space-y-2">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
            Витрина агентов
          </h1>
          <p className="text-muted-foreground max-w-2xl">
            Публичные AI-агенты сообщества. Откройте понравившегося в
            Telegram — там его можно запустить и настроить.
          </p>
        </header>

        <div className="flex items-center justify-between text-sm text-muted-foreground mb-4">
          <span>
            Найдено{' '}
            <strong className="text-foreground">{templates.length}</strong>{' '}
            {pluralRu(templates.length, ['агент', 'агента', 'агентов'])}
          </span>
        </div>

        <AgentTemplateGrid items={templates} />
      </section>
    </MainLayout>
  );
}

function pluralRu(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}
