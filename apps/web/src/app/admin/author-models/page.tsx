import Link from "next/link";
import { requireAdmin } from "@/lib/admin/guard";
import { getAuthorModerationQueue } from "@/lib/author/data";
export const dynamic = "force-dynamic";
export default async function AuthorModerationPage() {
  await requireAdmin();
  const models = await getAuthorModerationQueue();
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <Link href="/admin/models" className="text-sm">
        ← Все модели
      </Link>
      <h1 className="text-3xl font-semibold">Модели авторов</h1>
      <Link
        className="inline-block text-sm underline"
        href="/admin/author-requests"
      >
        Расчёты, возвраты и восстановление
      </Link>
      <p className="text-muted-foreground">
        Подключение, неизменяемые условия и явное согласие автора проверяются
        отдельно. Черновик не становится платной моделью автоматически.
      </p>
      <div className="grid gap-4">
        {models.map((m) => (
          <Link
            key={m.id}
            href={"/admin/author-models/" + m.id}
            className="rounded-xl border bg-card p-5 hover:border-primary"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <h2 className="font-semibold">{m.display_name ?? m.slug}</h2>
              <span className="text-sm text-muted-foreground">
                {m.status} · на проверке: {m.candidate_count}
              </span>
            </div>
            <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
              {m.slug}
            </p>
          </Link>
        ))}
      </div>
      {models.length === 0 && <p>Авторских заявок пока нет.</p>}
    </main>
  );
}
