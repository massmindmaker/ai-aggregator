import Link from "next/link";
import { requireAdmin } from "@/lib/admin/guard";
import { listAuthorOperatorRequests } from "@/lib/author/operator";
import { AuthorOperatorPanel } from "@/components/author/AuthorOperatorPanel";
export const dynamic = "force-dynamic";
export default async function AuthorRequestsPage() {
  await requireAdmin();
  const rows = await listAuthorOperatorRequests();
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <Link href="/admin/author-models" className="text-sm">
        ← Модели авторов
      </Link>
      <header>
        <h1 className="text-3xl font-semibold">Запросы и расчёты авторов</h1>
        <p className="mt-3 text-muted-foreground">
          Последние100запросов. Неизвестный исход не даёт разрешения на
          повторную генерацию. Все изменения денег выполняются через
          существующее списание и обязательный аудит.
        </p>
      </header>
      <AuthorOperatorPanel rows={rows} />
    </main>
  );
}
