import { SkeletonGrid } from '@/components/ui/skeletons';

export default function ContestsLoading() {
  return (
    <section className="container mx-auto max-w-7xl px-4 py-8 md:py-12">
      <header className="mb-6 space-y-2">
        <div className="aiag-skeleton h-9 w-64 rounded" aria-hidden="true" />
        <div className="aiag-skeleton h-4 w-96 rounded" aria-hidden="true" />
      </header>
      <SkeletonGrid count={6} cols={3} cardHeight={220} />
    </section>
  );
}
