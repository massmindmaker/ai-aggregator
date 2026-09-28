import Link from "next/link";
import MainLayout from "@/components/layout/MainLayout";
import { getPublicAuthorModels } from "@/lib/author/data";
import { formatAuthorCredits } from "@/lib/author/format";
export const dynamic = "force-dynamic";
export const metadata = { title: "Модели авторов — AI Aggregator" };
export default async function CommunityModelsPage() {
  const models = await getPublicAuthorModels();
  return (
    <MainLayout>
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
        <Link href="/marketplace" className="text-sm">
          ← Каталог провайдеров
        </Link>
        <header>
          <h1 className="text-3xl font-semibold">Модели авторов</h1>
          <p className="mt-3 max-w-3xl text-muted-foreground">
            Одобренные текстовые модели с фиксированной ценой за запрос. API
            сохраняет версию, цену и результат каждого принятого вызова.
          </p>
        </header>
        <div className="grid gap-4 md:grid-cols-2">
          {models.map((m) => (
            <Link
              key={m.id}
              href={"/marketplace/community/" + m.slug}
              className="rounded-xl border bg-card p-5 hover:border-primary"
            >
              <h2 className="text-xl font-semibold">
                {m.display_name ?? m.slug}
              </h2>
              <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">
                {m.description}
              </p>
              <p className="mt-5 font-semibold">
                {formatAuthorCredits(m.price_microcredits)} кредита за запрос
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Версия {m.version_no} · текстовый ответ
              </p>
            </Link>
          ))}
        </div>
        {models.length === 0 && (
          <p className="rounded-xl border p-5 text-muted-foreground">
            На этом стенде пока нет доступных авторских моделей.
          </p>
        )}
      </main>
    </MainLayout>
  );
}
