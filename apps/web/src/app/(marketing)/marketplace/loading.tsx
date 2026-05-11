import MainLayout from '@/components/layout/MainLayout';
import { SkeletonGrid } from '@/components/ui/skeletons';

export default function MarketplaceLoading() {
  return (
    <MainLayout>
      <section className="container mx-auto max-w-7xl px-4 py-8 md:py-12">
        <header className="mb-6 space-y-2">
          <div className="aiag-skeleton h-9 w-64 rounded" aria-hidden="true" />
          <div className="aiag-skeleton h-4 w-96 rounded" aria-hidden="true" />
        </header>
        <div className="grid lg:grid-cols-[280px_1fr] gap-8">
          <div className="hidden lg:block space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="aiag-skeleton h-10 rounded" aria-hidden="true" />
            ))}
          </div>
          <SkeletonGrid count={12} cols={4} cardHeight={220} />
        </div>
      </section>
    </MainLayout>
  );
}
