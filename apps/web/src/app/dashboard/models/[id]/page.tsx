import { auth } from '@/auth';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { db, sql } from '@/lib/db';
import { Badge } from '@/components/ui/Badge';

export const dynamic = 'force-dynamic';

interface ModelRow {
  id: string;
  slug: string;
  display_name: string | null;
  description: string | null;
  status: string;
  enabled: boolean;
  hosting_strategy: string;
  metadata: {
    review_state?: string;
    tier_pct?: number;
    submitted_at?: string;
    endpoint_url?: string;
    pricing_hint_per_request_rub?: number | null;
    exclusive?: boolean;
    approved_at?: string;
    approved_by?: string;
  };
  depublished_reason: string | null;
  frozen_reason: string | null;
  created_at: string;
  updated_at: string;
}

export default async function MyModelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/models');
  const { id } = await params;

  let model: ModelRow | undefined;
  try {
    const r = await db.execute(sql`
      SELECT id::text AS id, slug, display_name, description, status, enabled,
             hosting_strategy, metadata, depublished_reason, frozen_reason,
             created_at::text AS created_at, updated_at::text AS updated_at
      FROM models
      WHERE id = ${id}::uuid AND author_user_id = ${session.user.id}::uuid
      LIMIT 1
    `);
    model = (((r as unknown as { rows?: unknown[] }).rows ?? r) as ModelRow[])[0];
  } catch {
    notFound();
  }
  if (!model) notFound();

  const reviewing = model.status === 'draft' && model.metadata?.review_state === 'pending';
  const statusLabel = reviewing
    ? 'на модерации'
    : model.status === 'live'
      ? 'live'
      : model.status === 'depublished'
        ? 'снята'
        : model.status === 'frozen'
          ? 'заморожена'
          : 'черновик';
  const statusVariant: 'success' | 'warning' | 'destructive' | 'outline' =
    model.status === 'live'
      ? 'success'
      : reviewing
        ? 'warning'
        : ['depublished', 'frozen'].includes(model.status)
          ? 'destructive'
          : 'outline';

  return (
    <section className="container mx-auto max-w-3xl px-6 py-10">
      <Link
        href="/dashboard/models"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Все мои модели
      </Link>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {model.display_name || model.slug}
          </h1>
          <code className="text-sm text-muted-foreground font-mono">{model.slug}</code>
        </div>
        <Badge variant={statusVariant as never}>{statusLabel}</Badge>
      </div>

      {model.description && (
        <p className="mt-4 text-sm text-muted-foreground leading-relaxed">{model.description}</p>
      )}

      {(model.depublished_reason || model.frozen_reason) && (
        <div
          className="mt-5 rounded-md border p-4 text-sm"
          style={{
            borderColor: 'rgba(239,68,68,0.4)',
            background: 'rgba(239,68,68,0.05)',
          }}
        >
          <div className="font-medium text-red-500">
            {model.frozen_reason ? 'Причина заморозки' : 'Причина снятия'}
          </div>
          <div className="text-muted-foreground mt-1">
            {model.frozen_reason || model.depublished_reason}
          </div>
        </div>
      )}

      <div
        className="mt-8 rounded-md border p-6 grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-6 text-sm"
        style={{ borderColor: 'var(--line)' }}
      >
        <div className="text-muted-foreground">Хостинг</div>
        <div>
          {model.hosting_strategy === 'self_hosted_by_author'
            ? 'Self-hosted у автора'
            : model.hosting_strategy === 'hosted_on_aiag'
              ? 'На инфраструктуре AIAG'
              : 'Cloud-wrap (прокси)'}
        </div>

        <div className="text-muted-foreground">Tier ревшары</div>
        <div>{model.metadata?.tier_pct ?? '—'}%</div>

        <div className="text-muted-foreground">Endpoint</div>
        <div className="font-mono text-xs truncate">{model.metadata?.endpoint_url ?? '—'}</div>

        <div className="text-muted-foreground">Цена за запрос (hint)</div>
        <div>
          {model.metadata?.pricing_hint_per_request_rub != null
            ? `${model.metadata.pricing_hint_per_request_rub} ₽`
            : '—'}
        </div>

        <div className="text-muted-foreground">Эксклюзив</div>
        <div>{model.metadata?.exclusive ? 'Да' : 'Нет'}</div>

        <div className="text-muted-foreground">Создана</div>
        <div className="font-mono text-xs">{model.created_at?.slice(0, 16).replace('T', ' ')}</div>

        {model.metadata?.approved_at && (
          <>
            <div className="text-muted-foreground">Одобрена</div>
            <div className="font-mono text-xs">
              {model.metadata.approved_at.slice(0, 16).replace('T', ' ')}
              {model.metadata.approved_by && (
                <span className="text-muted-foreground"> · {model.metadata.approved_by}</span>
              )}
            </div>
          </>
        )}
      </div>

      {model.status === 'live' && (
        <div className="mt-6 text-sm">
          <Link
            href={`/marketplace/${model.slug}`}
            className="text-[var(--accent)] hover:underline"
          >
            Посмотреть страницу в маркетплейсе →
          </Link>
        </div>
      )}
    </section>
  );
}
