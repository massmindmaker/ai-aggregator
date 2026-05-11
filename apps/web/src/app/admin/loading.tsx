import { SkeletonStatTile, SkeletonChart, SkeletonTable } from '@/components/ui/skeletons';

export default function AdminLoading() {
  return (
    <div className="space-y-6 p-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonStatTile key={i} />
        ))}
      </div>
      <SkeletonChart height={240} />
      <SkeletonTable rows={6} cols={5} />
    </div>
  );
}
