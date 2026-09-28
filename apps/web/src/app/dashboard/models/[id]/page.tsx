import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAuthenticatedUser, uuidSchema } from "@/lib/author/http";
import { getAuthorModelView } from "@/lib/author/data";
import { AuthorModelPanel } from "@/components/author/AuthorModelPanel";
export const dynamic = "force-dynamic";
export default async function MyModelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const authUser = await getAuthenticatedUser();
  if (!authUser) redirect("/login?callbackUrl=/dashboard/models");
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) notFound();
  const view = await getAuthorModelView(id.data, authUser.user.id);
  if (!view) notFound();
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap gap-4 text-sm">
        <Link href="/dashboard/models">← Мои модели</Link>
        <Link href="/dashboard/earnings">Доходы и выплаты</Link>
      </div>
      <header>
        <h1 className="text-3xl font-semibold">
          {view.model.display_name ?? view.model.slug}
        </h1>
        <p className="mt-2 break-all font-mono text-sm text-muted-foreground">
          {view.model.slug}
        </p>
        <p className="mt-3 text-muted-foreground">{view.model.description}</p>
      </header>
      <AuthorModelPanel
        {...view}
        mode="owner"
        runtimeEnabled={process.env.AUTHOR_CHAT_ENABLED === "1"}
      />
      {view.model.status === "live" &&
        process.env.AUTHOR_CHAT_ENABLED === "1" && (
          <Link
            className="block text-sm underline"
            href={"/marketplace/community/" + view.model.slug}
          >
            Открыть опубликованную карточку
          </Link>
        )}
    </main>
  );
}
