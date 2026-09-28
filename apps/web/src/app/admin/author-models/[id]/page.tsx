import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin/guard";
import { uuidSchema } from "@/lib/author/http";
import { getAuthorModelView } from "@/lib/author/data";
import { AuthorModelPanel } from "@/components/author/AuthorModelPanel";
export const dynamic = "force-dynamic";
export default async function AdminAuthorModelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireAdmin();
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) notFound();
  const view = await getAuthorModelView(id.data, user.user.id, true);
  if (!view) notFound();
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <Link href="/admin/author-models" className="text-sm">
        ← Модерация авторов
      </Link>
      <header>
        <h1 className="text-3xl font-semibold">
          {view.model.display_name ?? view.model.slug}
        </h1>
        <p className="mt-2 break-all font-mono text-sm text-muted-foreground">
          {view.model.slug}
        </p>
      </header>
      <AuthorModelPanel
        {...view}
        mode="admin"
        runtimeEnabled={process.env.AUTHOR_CHAT_ENABLED === "1"}
      />
    </main>
  );
}
