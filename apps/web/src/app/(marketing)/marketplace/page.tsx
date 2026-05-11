import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { SlidersHorizontal } from 'lucide-react';
import { ModelGrid } from '@/components/marketplace/ModelCard';
import { CellsSpot } from '@/components/animations/CellsSpot';
import { FilterPanel } from '@/components/marketplace/FilterPanel';
import { computeFacets } from '@/lib/marketplace/facets';
import { ActiveFilterChips } from '@/components/marketplace/ActiveFilterChips';
import { SearchAndSort } from '@/components/marketplace/SearchAndSort';
import { getAllModels } from '@/lib/marketplace/catalog';
import {
  parseFiltersFromSearchParams,
  applyFilters,
  filtersToSearchParams,
} from '@/lib/marketplace/filters';

export const metadata: Metadata = {
  title: 'Каталог моделей — AI Aggregator',
  description:
    'Витрина AI-моделей: GPT, Claude, YandexGPT, DALL-E и ещё десятки моделей. Единый API, оплата в рублях, без VPN.',
  openGraph: {
    title: 'Каталог моделей — AI Aggregator',
    description:
      'Витрина AI-моделей: GPT, Claude, YandexGPT, DALL-E. Единый API, оплата в рублях.',
    type: 'website',
  },
  alternates: { canonical: '/marketplace' },
};

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Record<string, string | string[] | undefined>;
}

export default function MarketplacePage({ searchParams }: PageProps) {
  const all = getAllModels();
  const facets = computeFacets(all);
  const filters = parseFiltersFromSearchParams(searchParams);
  const result = applyFilters(all, filters);

  const orgNameBySlug = Object.fromEntries(
    facets.orgs.map((o) => [o.slug, o.name])
  );

  return (
    <MainLayout>
      <section className="aiag-grid-bg-sm container mx-auto max-w-7xl px-4 py-8 md:py-12">
        <header className="mb-6 space-y-2">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
            Каталог моделей
          </h1>
          <p className="text-muted-foreground max-w-2xl">
            Все модели доступны через один API. Оплата в рублях с баланса.
            Фильтры сохраняются в ссылке — делитесь подборкой.
          </p>
        </header>

        <div className="grid lg:grid-cols-[280px_1fr] gap-8">
          {/* Desktop filter rail */}
          <div className="hidden lg:block sticky top-20 self-start max-h-[calc(100vh-6rem)] overflow-y-auto pr-2">
            <Suspense
              fallback={<div className="h-64 animate-pulse bg-muted rounded" />}
            >
              <FilterPanel orgs={facets.orgs} tags={facets.tags} />
            </Suspense>
          </div>

          {/* Results column */}
          <div className="space-y-4 min-w-0">
            <div className="flex gap-2 items-center">
              <div className="flex-1">
                <Suspense
                  fallback={
                    <div className="h-10 bg-muted rounded animate-pulse" />
                  }
                >
                  <SearchAndSort />
                </Suspense>
              </div>
              {/* Mobile filters */}
              <Sheet>
                <SheetTrigger asChild>
                  <Button variant="outline" size="sm" className="lg:hidden">
                    <SlidersHorizontal className="h-4 w-4 me-2" aria-hidden />
                    Фильтры
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-[320px] overflow-y-auto">
                  <SheetHeader>
                    <SheetTitle>Фильтры</SheetTitle>
                  </SheetHeader>
                  <div className="mt-4">
                    <Suspense>
                      <FilterPanel orgs={facets.orgs} tags={facets.tags} />
                    </Suspense>
                  </div>
                </SheetContent>
              </Sheet>
            </div>

            <Suspense>
              <ActiveFilterChips orgNameBySlug={orgNameBySlug} />
            </Suspense>

            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Найдено{' '}
                <strong className="text-foreground">{result.total}</strong>{' '}
                {pluralRu(result.total, ['модель', 'модели', 'моделей'])}
              </span>
              {result.totalPages > 1 && (
                <span>
                  Страница {result.page} из {result.totalPages}
                </span>
              )}
            </div>

            <ModelGrid
              items={result.items}
              empty={
                <div className="flex flex-col items-center py-8">
                  <CellsSpot width={240} height={160} />
                  <p className="mt-6 text-sm opacity-70">
                    Моделей не найдено. Попробуйте изменить фильтры.
                  </p>
                </div>
              }
            />

            <Pagination
              page={result.page}
              totalPages={result.totalPages}
              searchParams={searchParams}
            />
          </div>
        </div>
      </section>
    </MainLayout>
  );
}

function Pagination({
  page,
  totalPages,
  searchParams,
}: {
  page: number;
  totalPages: number;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  if (totalPages <= 1) return null;
  const hrefFor = (p: number) => {
    const filters = parseFiltersFromSearchParams(searchParams);
    const sp = filtersToSearchParams({ ...filters, page: p });
    const qs = sp.toString();
    return qs ? `/marketplace?${qs}` : '/marketplace';
  };
  return (
    <nav
      aria-label="Пагинация"
      className="flex items-center justify-center gap-2 pt-4"
    >
      <Link
        href={hrefFor(Math.max(1, page - 1))}
        aria-disabled={page === 1}
        className={
          page === 1
            ? 'pointer-events-none opacity-50 px-3 py-1.5 text-sm border border-border rounded-md'
            : 'px-3 py-1.5 text-sm border border-border rounded-md hover:bg-secondary'
        }
      >
        ← Назад
      </Link>
      <span className="text-sm text-muted-foreground px-2">
        {page} / {totalPages}
      </span>
      <Link
        href={hrefFor(Math.min(totalPages, page + 1))}
        aria-disabled={page === totalPages}
        className={
          page === totalPages
            ? 'pointer-events-none opacity-50 px-3 py-1.5 text-sm border border-border rounded-md'
            : 'px-3 py-1.5 text-sm border border-border rounded-md hover:bg-secondary'
        }
      >
        Вперёд →
      </Link>
    </nav>
  );
}

function pluralRu(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}
