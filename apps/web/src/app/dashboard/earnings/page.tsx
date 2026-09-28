import Link from "next/link";
import { redirect } from "next/navigation";
import { db, sql } from "@/lib/db";
import { getAuthenticatedUser } from "@/lib/author/http";
import { getAuthorEarnings } from "@/lib/author/data";
import { authorRows, isAuthorMockMode } from "@/lib/author/service";
import { formatAuthorCredits } from "@/lib/author/format";
import { MockAuthorPayoutPanel } from "@/components/author/MockAuthorPayoutPanel";
export const dynamic = "force-dynamic";
export const metadata = { title: "Мои доходы — AI Aggregator" };
export default async function EarningsPage() {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/login?callbackUrl=/dashboard/earnings");
  const { balance, ledger, payouts } = await getAuthorEarnings(user.user.id);
  const legacy = authorRows<{ status: string; amount: string }>(
    await db.execute(
      sql`SELECT status,sum(author_share_rub)::text AS amount FROM author_earnings WHERE author_id=${user.user.id}::uuid GROUP BY status`,
    ),
  );
  const stats = [
    ["Доступно", balance.available_microcredits],
    ["Удержано / спор", balance.pending_microcredits],
    ["Зарезервировано в тесте", balance.reserved_microcredits],
    ["Тестовые выплаты", balance.paid_microcredits],
  ];
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-3xl font-semibold">Мои доходы</h1>
        <Link href="/dashboard/models" className="text-sm underline">
          Мои модели
        </Link>
      </div>
      <p className="text-muted-foreground">
        Начисления привязаны к подтверждённому списанию и конкретной версии
        модели. Возврат покупателю отражается отдельной обратной записью, а не
        изменением старого чека.
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(([label, value]) => (
          <section key={label} className="rounded-xl border bg-card p-5">
            <h2 className="text-sm text-muted-foreground">{label}</h2>
            <p className="mt-3 break-words text-2xl font-semibold tabular-nums">
              {formatAuthorCredits(value)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">кредитов</p>
          </section>
        ))}
      </div>
      {BigInt(balance.available_microcredits) < 0n && (
        <p className="rounded border p-4 text-sm">
          После возврата образовалось обязательство автора. Следующие начисления
          сначала покрывают эту сумму; новая выплата недоступна.
        </p>
      )}
      <MockAuthorPayoutPanel
        actorId={user.user.id}
        availableMicrocredits={balance.available_microcredits}
        enabled={isAuthorMockMode()}
      />
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-xl font-semibold">Начисления и возвраты</h2>
        {ledger.length === 0 ? (
          <p className="mt-4 text-muted-foreground">
            Подтверждённых начислений пока нет.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {ledger.map((row) => (
              <article
                key={row.billing_request_id + row.kind}
                className="grid gap-2 border-t pt-3 text-sm sm:grid-cols-[1fr_auto]"
              >
                <div>
                  <p className="break-all font-medium">
                    {row.model_slug} · версия {row.version_no}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {row.kind === "reversal" ? "Возврат" : "Начисление"}
                    {row.disputed ? " · спор" : ""}
                  </p>
                  <code className="mt-1 block break-all text-xs text-muted-foreground">
                    {row.billing_request_id}
                  </code>
                </div>
                <div className="sm:text-right">
                  <p className="font-semibold tabular-nums">
                    {formatAuthorCredits(row.amount_microcredits)} кредита
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Доступность:{" "}
                    {new Date(row.available_at).toLocaleDateString("ru-RU")}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {payouts.length > 0 && (
        <section className="rounded-xl border p-5">
          <h2 className="text-xl font-semibold">История тестовых выплат</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Это симуляции, не банковские или блокчейн-переводы.
          </p>
          <div className="mt-4 space-y-3">
            {payouts.map((p) => (
              <div key={p.id} className="border-t pt-3 text-sm">
                <p>
                  {formatAuthorCredits(p.amount_microcredits)} кредита ·{" "}
                  {p.state}
                </p>
                <code className="block break-all text-xs text-muted-foreground">
                  {p.receipt_reference ?? p.id}
                </code>
              </div>
            ))}
          </div>
        </section>
      )}
      {legacy.length > 0 && (
        <section className="rounded-xl border p-5">
          <h2 className="text-xl font-semibold">
            Архив прежней системы, рубли
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Не суммируется с кредитами нового учёта.
          </p>
          {legacy.map((row) => (
            <p key={row.status} className="mt-3 text-sm">
              {row.status}: {row.amount} ₽
            </p>
          ))}
        </section>
      )}
    </main>
  );
}
