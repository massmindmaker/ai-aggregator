'use client';

import Link from 'next/link';
import { Check, Sparkles, ArrowRight } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import type { GramPricingView } from '@/lib/ton-wallet/pricing-packages';

/**
 * Gram-storefront (task 4): the public pricing page sells top-up credit
 * packages priced in Gram (TON), not ruble subscriptions. Every displayed
 * amount comes straight from `GramPricingView` (task 3), whose BigInt math
 * mirrors the payment contract — the storefront never re-types prices.
 * `import type` above keeps the policy reader (and its DB imports) out of
 * the client bundle; the server component passes the plain view down.
 *
 * Deleted with the rub tiers: TIER_COPY, monthly/yearly switch, −15% badge,
 * payment-provider selector and the dead handleSubscribe fetch — checkout
 * now lives on /dashboard/billing (wallet payment), this page only links to it.
 */

const PACKAGE_FEATURES = [
  'Pay-per-request: платите за фактические запросы',
  'Кредиты не сгорают',
  'Оплата кошельком Gram (TON)',
];

interface PricingClientProps {
  isLoggedIn: boolean;
  view: GramPricingView | null;
}

export default function PricingClient({ isLoggedIn, view }: PricingClientProps) {
  const registerHref = `/register?callbackUrl=${encodeURIComponent('/pricing')}`;

  return (
    <MainLayout>
      <section className="container mx-auto max-w-7xl px-4 py-16 md:py-20">
        <div className="text-center max-w-3xl mx-auto mb-12">
          <Badge
            variant="outline"
            className="rounded-full border-primary/40 text-primary px-3 py-1 mb-4"
          >
            Прозрачные тарифы
          </Badge>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
            Платите за то, что используете
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Pay-per-request, списание в кредитах (1 кредит = 1 цент). Покупайте
            пакет кредитов — цена запроса от пакета не зависит.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Курс фиксируется на момент оплаты.
          </p>

          {view?.stale && (
            <div
              role="status"
              className="mt-5 inline-block rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-primary"
            >
              Курс обновляется — цена зафиксируется при оплате
            </div>
          )}
        </div>

        {view === null ? (
          /* Policy missing/invalid: honest empty state, page stays 200. */
          <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-10 text-center">
            <h2 className="text-2xl font-semibold">Пакеты скоро появятся</h2>
            <p className="mt-3 text-muted-foreground">
              Витрина пакетов настраивается. Баланс уже можно пополнить
              кошельком Gram в биллинге.
            </p>
            <Button asChild className="mt-6" variant="default" size="lg">
              <Link href="/dashboard/billing">
                Пополнить
                <ArrowRight className="ms-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 aiag-stagger">
            {view.packages.map((pkg, index) => {
              const isPopular = index === 1;
              return (
                <div
                  key={pkg.id}
                  className={cn(
                    'relative flex flex-col rounded-2xl border bg-card p-6 transition-all',
                    isPopular
                      ? 'border-primary/60 shadow-[0_0_0_1px_rgba(245,158,11,0.4),0_24px_64px_-16px_rgba(245,158,11,0.25)]'
                      : 'border-border hover:border-primary/30 aiag-glow-hover'
                  )}
                >
                  {isPopular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <Badge className="bg-primary text-primary-foreground border-0 shadow-md">
                        <Sparkles className="me-1 h-3 w-3" /> Популярный
                      </Badge>
                    </div>
                  )}

                  <div className="mb-1 flex items-center gap-2">
                    <h3 className="text-xl font-semibold">{pkg.label}</h3>
                    {view.testnet && (
                      <Badge
                        variant="outline"
                        className="px-1.5 py-0 text-[10px] uppercase tracking-wide text-muted-foreground"
                      >
                        Testnet
                      </Badge>
                    )}
                  </div>

                  <div className="mt-5 mb-2">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-4xl font-bold tracking-tight">
                        ≈ {pkg.grams}
                      </span>
                      <span className="text-lg text-muted-foreground">GRAM</span>
                    </div>
                    <div className="mt-3 inline-flex items-center rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1 text-xs font-mono text-primary">
                      {pkg.credits} кредитов
                    </div>
                  </div>

                  <ul className="mt-5 space-y-2.5 flex-1">
                    {PACKAGE_FEATURES.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-sm">
                        <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                        <span className="text-foreground/90">{f}</span>
                      </li>
                    ))}
                  </ul>

                  <Button asChild className="mt-6 w-full" variant="default" size="lg">
                    <Link href={isLoggedIn ? '/dashboard/billing' : registerHref}>
                      {isLoggedIn ? 'Пополнить баланс' : 'Начать'}
                      <ArrowRight className="ms-2 h-4 w-4" />
                    </Link>
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {/* Enterprise / Business contact */}
        <div className="mt-10 rounded-2xl border border-border bg-card/60 p-8 md:p-10 flex flex-col md:flex-row md:items-center gap-6">
          <div className="flex-1">
            <h3 className="text-xl md:text-2xl font-semibold">
              Business / Enterprise
            </h3>
            <p className="text-muted-foreground mt-2">
              Условия для крупных объёмов, юрлиц и SLA обсуждаем отдельно —{' '}
              напишите нам, соберём расчёт под вашу нагрузку.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <Button asChild size="lg" variant="outline">
              <a href="mailto:team@ai-aggregator.ru?subject=Business plan">
                Обсудить условия
              </a>
            </Button>
            <Button asChild size="lg" variant="ghost">
              <Link href="/docs">Посмотреть docs</Link>
            </Button>
          </div>
        </div>

        <p className="mt-10 text-center text-sm text-muted-foreground">
          Все пакеты включают доступ к OpenAI-совместимому API и RU-residency
          для критичных моделей.
        </p>
      </section>
    </MainLayout>
  );
}
