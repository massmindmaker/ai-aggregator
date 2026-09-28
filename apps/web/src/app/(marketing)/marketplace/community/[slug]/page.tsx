import Link from "next/link";
import { notFound } from "next/navigation";
import MainLayout from "@/components/layout/MainLayout";
import { getPublicAuthorModels } from "@/lib/author/data";
import { formatAuthorCredits } from "@/lib/author/format";
export const dynamic = "force-dynamic";
export default async function PublicAuthorModelPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug)) notFound();
  const model = (await getPublicAuthorModels(slug))[0];
  if (!model) notFound();
  const example = JSON.stringify(
    {
      model: slug,
      messages: [{ role: "user", content: "Привет!" }],
      stream: false,
      max_tokens: 256,
    },
    null,
    2,
  );
  return (
    <MainLayout>
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
        <Link href="/marketplace/community" className="text-sm">
          ← Модели авторов
        </Link>
        <header>
          <h1 className="text-3xl font-semibold">
            {model.display_name ?? model.slug}
          </h1>
          <p className="mt-3 text-muted-foreground">{model.description}</p>
        </header>
        <section className="rounded-xl border bg-card p-5">
          <p className="text-2xl font-semibold">
            {formatAuthorCredits(model.price_microcredits)} кредита за запрос
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Текущая версия: {model.version_no}. Публикация одобрена модератором,
            условия приняты автором. Размещение сервера в РФ не подтверждено;
            ограничения ключа на передачу данных сохраняются.
          </p>
        </section>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Вызов через общий API</h2>
          <p className="text-sm">
            POST /v1/chat/completions · Authorization: Bearer YOUR_API_KEY ·
            Idempotency-Key: YOUR_REQUEST_ID
          </p>
          <pre className="overflow-x-auto rounded-xl border bg-muted/20 p-4 text-xs">
            {example}
          </pre>
          <p className="text-sm text-muted-foreground">
            Поддерживается обычный текстовый ответ. Потоковый режим, инструменты
            и собственный ключ провайдера для этой версии не поддерживаются.
            Цена фиксируется при приёме запроса; повтор с тем же ключом
            возвращает сохранённый результат без нового вызова.
          </p>
          <Link href="/dashboard/keys" className="inline-block underline">
            Открыть API-ключи
          </Link>
        </section>
        <dl className="space-y-3 rounded-xl border p-5 text-sm">
          <dt>Отпечаток версии</dt>
          <dd className="break-all font-mono text-xs">
            {model.manifest_digest}
          </dd>
          <dt>Отпечаток условий</dt>
          <dd className="break-all font-mono text-xs">{model.policy_digest}</dd>
        </dl>
      </main>
    </MainLayout>
  );
}
