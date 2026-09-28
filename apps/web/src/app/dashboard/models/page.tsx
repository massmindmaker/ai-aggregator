import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db, sql } from "@/lib/db";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/Table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Мои модели — AI-Aggregator" };

interface Row {
  id: string;
  current_version_no: number | null;
  slug: string;
  display_name: string | null;
  status: string;
  enabled: boolean;
  hosting_strategy: string;
  metadata: { review_state?: string; tier_pct?: number; submitted_at?: string };
  created_at: string;
}

const STATUS_META: Record<
  string,
  {
    label: string;
    variant: "default" | "success" | "warning" | "destructive" | "outline";
  }
> = {
  draft_review: { label: "на модерации", variant: "warning" },
  draft: { label: "черновик", variant: "outline" },
  pending_author_consent: { label: "ждёт согласия", variant: "warning" },
  live: { label: "live", variant: "success" },
  frozen: { label: "заморожена", variant: "destructive" },
  depublished: { label: "снята", variant: "destructive" },
};

export default async function DashboardModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ submitted?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/dashboard/models");
  const userId = session.user.id;
  const params = await searchParams;
  const justSubmitted = params.submitted === "1";

  const r = await db.execute(sql`
    SELECT id, slug, display_name, status, enabled, hosting_strategy, metadata, created_at,
      (SELECT v.version_no FROM author_model_versions v WHERE v.id=models.current_author_version_id) AS current_version_no
    FROM models
    WHERE author_user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT 100
  `);
  const rows = ((r as unknown as { rows?: unknown[] }).rows ?? r) as Row[];

  return (
    <>
      <div className="container mx-auto px-4 py-10 max-w-5xl">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight mb-2">
              Мои модели
            </h1>
            <p className="text-muted-foreground">
              Модели, которые вы загрузили в AI-Aggregator. После одобрения они
              появятся в маркетплейсе.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/dashboard/earnings">
              <Button variant="outline">Доходы</Button>
            </Link>
            <Link href="/dashboard/models/new">
              <Button>+ Добавить модель</Button>
            </Link>
          </div>
        </div>

        {justSubmitted && (
          <div className="mb-6 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
            <div className="font-medium text-emerald-700 dark:text-emerald-400">
              Заявка отправлена на модерацию
            </div>
            <div className="text-muted-foreground mt-1">
              Проверка подключения и условия появятся здесь. Публикация возможна
              после вашего согласия и решения модератора.
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <div className="rounded-lg border bg-card">
            <EmptyState
              illustration="models"
              title="Пока ни одной модели"
              description="Подключите модель и согласуйте условия. Начисления появятся после подтверждённых вызовов."
              actionLabel="Загрузить первую модель"
              actionHref="/dashboard/models/new"
            />
          </div>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Модель</TableHead>
                  <TableHead>Хостинг</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead>Версия</TableHead>
                  <TableHead>Дата</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => {
                  const reviewing =
                    m.status === "draft" &&
                    m.metadata?.review_state === "pending";
                  const key = reviewing ? "draft_review" : m.status;
                  const meta = STATUS_META[key] ?? STATUS_META.draft;
                  return (
                    <TableRow key={m.id}>
                      <TableCell>
                        <Link
                          href={`/dashboard/models/${m.id}`}
                          className="font-medium underline underline-offset-4"
                        >
                          {m.display_name || m.slug}
                        </Link>
                        <div className="text-xs text-muted-foreground font-mono">
                          {m.slug}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {m.hosting_strategy === "self_hosted_by_author"
                            ? "self-host"
                            : m.hosting_strategy === "hosted_on_aiag"
                              ? "on AIAG"
                              : "cloud-wrap"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={meta.variant as never}>
                          {meta.label}
                        </Badge>
                      </TableCell>
                      <TableCell>{m.current_version_no ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(m.created_at).toLocaleDateString("ru-RU")}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  );
}
