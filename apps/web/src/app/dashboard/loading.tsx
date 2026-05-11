import { SkeletonStatTile, SkeletonTable } from '@/components/ui/skeletons';

export default function DashboardLoading() {
  return (
    <div className="space-y-6 p-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonStatTile key={i} />
        ))}
      </div>
      <SkeletonTable rows={6} cols={4} />
    </div>
  );
}
