import { SkeletonTable } from '@/components/ui/skeletons';

export default function AdminRequestsLoading() {
  return (
    <div className="p-6">
      <SkeletonTable rows={10} cols={6} />
    </div>
  );
}
