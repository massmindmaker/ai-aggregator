import type { Metadata } from 'next';
import Link from 'next/link';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/Button';
import { PricingCalculator } from '@/components/marketplace/PricingCalculator';
import { ArrowLeft } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Калькулятор цен — AI Aggregator',
  description:
    'Посчитайте стоимость использования AI-моделей: GPT, Claude, YandexGPT, DALL-E и других. Цены в рублях, наценка шлюза уже включена.',
  alternates: { canonical: '/marketplace/calculator' },
};

export default function CalculatorPage() {
  return (
    <MainLayout>
      <section className="container mx-auto max-w-4xl px-4 py-6 md:py-10">
        <Button variant="ghost" size="sm" asChild leftIcon={<ArrowLeft className="h-4 w-4" />} className="mb-4">
          <Link href="/marketplace">Каталог моделей</Link>
        </Button>

        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
            Калькулятор стоимости
          </h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            Прикиньте месячный бюджет для любой модели из каталога. Все цифры — в
            рублях, наценка шлюза уже включена в цену. Реальные счета могут
            отличаться в зависимости от длины ответов.
          </p>
        </header>

        <PricingCalculator />
      </section>
    </MainLayout>
  );
}
