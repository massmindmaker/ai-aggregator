"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { formatAuthorCredits } from "@/lib/author/format";
import type {
  AuthorOperatorRow,
  AuthorOperatorAction,
} from "@/lib/author/operator";
const labels: Record<string, string> = {
  held: "Зарезервировано",
  dispatched: "Исход вызова не подтверждён",
  outcome_recorded: "Результат сохранён, расчёт ожидается",
  settled: "Расчёт завершён",
  cancelled: "Отменено без вызова",
};
export function AuthorOperatorPanel({
  rows,
}: {
  rows: readonly AuthorOperatorRow[];
}) {
  return (
    <div className="space-y-5">
      {rows.length === 0 ? (
        <p className="rounded-xl border p-5 text-muted-foreground">
          Авторских запросов пока нет.
        </p>
      ) : (
        rows.map((row) => (
          <RequestCard key={row.billing_request_id} row={row} />
        ))
      )}
    </div>
  );
}
function RequestCard({ row: r }: { row: AuthorOperatorRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [noChargeConfirmed, setNoChargeConfirmed] = useState(false),
    [message, setMessage] = useState("");
  async function act(action: AuthorOperatorAction) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        "/api/admin/author-requests/" + r.billing_request_id,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action),
        },
      );
      const result = await response.json();
      setMessage(
        response.ok
          ? "Сохранено. Расчёт подтверждён базой данных."
          : result.error === "AUTHOR_RECONCILIATION_NOT_DUE"
            ? "Срок ожидания ещё не истёк. Повторный вызов модели не выполняется."
            : "Операция не подтверждена. Обновите состояние и проверьте исход.",
      );
      router.refresh();
    } catch {
      setMessage(
        "Связь прервалась. Проверьте сохранённый результат; повтор с тем же запросом не создаёт новое списание.",
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  function noCharge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!r.attempt_id || !noChargeConfirmed) return;
    const data = new FormData(event.currentTarget);
    void act({
      action: "no_charge",
      attemptId: r.attempt_id,
      evidenceReference: String(data.get("evidence")),
    });
  }
  return (
    <article className="rounded-xl border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap justify-between gap-3">
        <Link
          href={"/admin/author-models/" + r.model_id}
          className="break-all font-semibold underline"
        >
          {r.model_slug} · версия {r.version_no}
        </Link>
        <span className="text-sm text-muted-foreground">
          {labels[r.state ?? ""] ?? "Ожидает приёма"}
        </span>
      </div>
      <code className="mt-3 block break-all text-xs text-muted-foreground">
        {r.billing_request_id}
      </code>
      <div className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
        <p>Цена: {formatAuthorCredits(r.price_microcredits)} кредита</p>
        <p>
          Списано:{" "}
          {r.actual_cost_credits === null
            ? "Не подтверждено"
            : formatAuthorCredits(r.actual_cost_credits) + " кредита"}
        </p>
        <p>Доля автора: {formatAuthorCredits(r.author_microcredits)} кредита</p>
      </div>
      {r.no_charge && (
        <p className="mt-3 text-sm">
          Проверенный исход без списания. Резерв освобождён; начисление автору
          не создано.
        </p>
      )}
      {r.refunded && (
        <p className="mt-3 text-sm">
          Полный возврат записан. Старый чек сохранён; начисление автора
          отменено отдельной записью.
        </p>
      )}
      {r.state === "outcome_recorded" && (
        <div className="mt-4">
          <p className="mb-3 text-sm text-muted-foreground">
            Результат уже сохранён. Восстановление завершает только расчёт, без
            нового обращения к модели.
          </p>
          <Button
            disabled={busy}
            onClick={() => void act({ action: "recover" })}
          >
            Завершить сохранённый расчёт
          </Button>
        </div>
      )}
      {r.state === "settled" && !r.refunded && !r.no_charge && (
        <div className="mt-4 space-y-3">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-1"
            />
            Подтверждаю полный возврат списания покупателю и обратное начисление
            автору. Истёкшие подписочные кредиты не превращаются в деньги.
          </label>
          <Button
            variant="outline"
            disabled={busy || !confirmed}
            onClick={() => void act({ action: "refund" })}
          >
            Вернуть списание
          </Button>
        </div>
      )}
      {r.state === "dispatched" && (
        <form
          onSubmit={noCharge}
          className="mt-4 space-y-3 rounded-lg border p-4"
        >
          <p className="text-sm">
            Модель повторно не запускается. Освободить резерв можно только после
            срока сверки и документального подтверждения поставщика, что
            результат и списание отсутствуют.
          </p>
          <p className="text-xs text-muted-foreground">
            Срок сверки:{" "}
            {r.reconcile_after
              ? new Date(r.reconcile_after).toLocaleString("ru-RU")
              : "Не установлен"}
          </p>
          <label className="grid gap-2 text-sm">
            Подтверждение поставщика
            <Input
              name="evidence"
              required
              minLength={3}
              maxLength={1024}
              placeholder="Номер обращения или документа"
            />
          </label>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={noChargeConfirmed}
              onChange={(e) => setNoChargeConfirmed(e.target.checked)}
              className="mt-1"
            />
            Проверил подтверждение: результата нет, списание не требуется.
          </label>
          <Button
            type="submit"
            disabled={busy || !noChargeConfirmed || !r.attempt_id}
          >
            Подтвердить отсутствие списания
          </Button>
        </form>
      )}
      {!r.refunded && !r.no_charge && (
        <form
          className="mt-5 flex flex-col gap-3 border-t pt-4 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void act({
              action: "dispute",
              disputed: !r.disputed,
              reason: String(data.get("reason")),
            });
          }}
        >
          <Input
            name="reason"
            minLength={3}
            maxLength={1024}
            required
            placeholder="Основание решения по спору"
            aria-label="Основание решения по спору"
          />
          <Button type="submit" variant="outline" disabled={busy}>
            {r.disputed ? "Закрыть спор" : "Удержать начисление на время спора"}
          </Button>
        </form>
      )}
      {message && (
        <p role="status" className="mt-4 text-sm">
          {message}
        </p>
      )}
    </article>
  );
}
