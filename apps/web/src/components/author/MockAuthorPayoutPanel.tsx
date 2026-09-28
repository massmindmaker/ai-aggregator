"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

type Intent = {
  key: string;
  recipientReference: string;
  amountMicrocredits: string;
};
export function MockAuthorPayoutPanel({
  actorId,
  availableMicrocredits,
  enabled,
}: {
  actorId: string;
  availableMicrocredits: string;
  enabled: boolean;
}) {
  const router = useRouter(),
    intent = useRef<Intent | null>(null),
    storageKey = "aiag:mock-payout:" + actorId;
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  if (!enabled)
    return (
      <p className="rounded-lg border p-4 text-sm text-muted-foreground">
        Реальный перевод средств не подключён. Тестовые выплаты доступны только
        на отдельном локальном стенде.
      </p>
    );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (!intent.current) {
        try {
          const saved = sessionStorage.getItem(storageKey);
          if (saved) {
            const parsed = JSON.parse(saved);
            if (
              typeof parsed.key === "string" &&
              typeof parsed.recipientReference === "string" &&
              typeof parsed.amountMicrocredits === "string"
            )
              intent.current = parsed;
          }
        } catch {
          /* storage is optional; current component keeps identity */
        }
      }
      if (!intent.current) {
        const data = new FormData(event.currentTarget);
        intent.current = {
          key: crypto.randomUUID(),
          recipientReference: String(data.get("recipient")),
          amountMicrocredits: String(data.get("amount")),
        };
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(intent.current));
        } catch {
          /* no cross-request secret is stored */
        }
      }
      const current = intent.current;
      const response = await fetch("/api/author/payouts/mock", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": current.key,
        },
        body: JSON.stringify({
          recipientReference: current.recipientReference,
          amountMicrocredits: current.amountMicrocredits,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(
          result.error === "AUTHOR_PAYOUT_BALANCE"
            ? "Недостаточно доступного начисления."
            : "Операция не подтверждена. Проверьте историю перед повтором.",
        );
        setPending(true);
        router.refresh();
        return;
      }
      if (result.state === "paid") {
        setMessage("Тестовая операция подтверждена без реального перевода.");
        setPending(false);
        intent.current = null;
        try {
          sessionStorage.removeItem(storageKey);
        } catch {}
      } else {
        setMessage(
          "Исход неизвестен. Проверка использует ту же операцию и не создаёт повторную выплату.",
        );
        setPending(true);
      }
      router.refresh();
    } catch {
      setMessage(
        "Исход неизвестен: связь прервалась. Проверьте ту же операцию.",
      );
      setPending(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-xl border p-5">
      <h2 className="text-xl font-semibold">Проверка выплаты</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Только симуляция: деньги на кошелёк или банковский счёт не переводятся.
        Операция резервирует тестовые начисления этого стенда.
      </p>
      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-2 text-sm">
          Тестовый получатель
          <Input
            name="recipient"
            placeholder="mock:wallet"
            required
            disabled={busy || pending}
            defaultValue="mock:wallet"
          />
        </label>
        <label className="grid gap-2 text-sm">
          Сумма, микрокредиты
          <Input
            name="amount"
            required
            inputMode="numeric"
            pattern="[1-9][0-9]*"
            disabled={busy || pending}
          />
        </label>
        <Button
          type="submit"
          disabled={busy || (!pending && BigInt(availableMicrocredits) <= 0n)}
          className="sm:col-span-2"
        >
          {pending ? "Проверить ту же операцию" : "Создать тестовую выплату"}
        </Button>
      </form>
      {message && (
        <p role="status" className="mt-4 text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
