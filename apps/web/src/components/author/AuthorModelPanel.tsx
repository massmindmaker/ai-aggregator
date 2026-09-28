"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  formatAuthorCredits,
  formatAuthorShare,
  authorPercentToBps,
} from "@/lib/author/format";
import type { AuthorModelView, AuthorVersionView } from "@/lib/author/data";

const errors: Record<string, string> = {
  AUTHOR_POLICY_CONFLICT:
    "Условия уже зафиксированы. Для изменения создайте новую версию.",
  AUTHOR_VERSION_CONFLICT: "Версия изменилась. Обновите страницу.",
  AUTHOR_OWNER_REQUIRED: "Эта модель недоступна вашему аккаунту.",
  AUTHOR_ADMIN_REQUIRED: "Требуется подтверждённый вход администратора.",
  AUTHOR_APPROVAL_NOT_READY:
    "Нужны успешная проверка и согласие автора с условиями.",
  AUTHOR_RUNTIME_DISABLED:
    "Исполнение авторских моделей на этом стенде ещё не включено.",
  AUTHOR_PROBE_REVIEW_REQUIRED:
    "Сначала нужен разбор предыдущей неопределённой проверки этой модели.",
  AUTHOR_KEY_UNAVAILABLE: "На сервере не настроено шифрование ключей.",
  AUTHOR_INPUT_INVALID: "Проверьте поля и точные значения.",
};
const stateLabels: Record<string, string> = {
  candidate: "На проверке",
  approved: "Одобрена",
  rejected: "Отклонена",
  depublished: "Снята",
  succeeded: "Подключение проверено",
  failed: "Проверка не пройдена",
  dispatching: "Проверка начата",
  unknown: "Исход неизвестен",
};
type Props = {
  model: AuthorModelView;
  versions: readonly AuthorVersionView[];
  mode: "owner" | "admin";
  runtimeEnabled: boolean;
};
export function AuthorModelPanel({
  model,
  versions,
  mode,
  runtimeEnabled,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const endpoint =
    mode === "admin"
      ? "/api/admin/models/" + model.id + "/author"
      : "/api/author/models/" + model.id;
  async function perform(payload: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(
          errors[result.error] ??
            "Не удалось подтвердить операцию. Обновите страницу.",
        );
        router.refresh();
        return;
      }
      setMessage(
        result.state === "unknown"
          ? "Операция сохранена с неизвестным исходом. Автоматический повтор запрещён."
          : "Сохранено.",
      );
      router.refresh();
    } catch {
      setMessage(
        "Связь прервалась. Обновите страницу и проверьте сохранённый результат перед повтором.",
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  async function newVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      data = new FormData(form);
    const payload = {
      action: "new_version",
      name: String(data.get("name")),
      description: String(data.get("description")),
      endpointUrl: String(data.get("endpointUrl")),
      authToken: String(data.get("authToken")),
      expectedLatestVersionNo: versions[0]?.version_no ?? 0,
    };
    const password = form.elements.namedItem(
      "authToken",
    ) as HTMLInputElement | null;
    if (password) password.value = "";
    await perform(payload);
  }
  return (
    <div className="space-y-6">
      {!runtimeEnabled && (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">
          На этом стенде вызовы авторских моделей отключены. Проверка и принятие
          условий не означают начало продаж.
        </p>
      )}
      {message && (
        <p role="status" className="rounded-lg border bg-muted/30 p-4 text-sm">
          {message}
        </p>
      )}
      {versions.length === 0 && (
        <p className="text-muted-foreground">
          Версий нового авторского формата пока нет.
        </p>
      )}
      {versions.map((version) => (
        <VersionCard
          key={version.id}
          model={model}
          version={version}
          mode={mode}
          busy={busy}
          enabled={runtimeEnabled}
          perform={perform}
        />
      ))}
      {mode === "owner" && versions.length > 0 && (
        <section className="rounded-xl border bg-card p-5 sm:p-6">
          <h2 className="text-xl font-semibold">Новая версия</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Изменение адреса, ключа, описания или условий создаёт отдельную
            версию. Текущие запросы сохраняют прежнюю версию и цену.
          </p>
          <form onSubmit={newVersion} className="mt-5 grid gap-4">
            <label className="grid gap-2 text-sm">
              Название
              <Input
                name="name"
                defaultValue={model.display_name ?? model.slug}
                required
                minLength={3}
                maxLength={128}
              />
            </label>
            <label className="grid gap-2 text-sm">
              Описание
              <textarea
                name="description"
                defaultValue={model.description ?? ""}
                required
                minLength={10}
                maxLength={4000}
                rows={3}
                className="rounded border bg-background p-3"
              />
            </label>
            <label className="grid gap-2 text-sm">
              HTTPS-адрес API
              <Input
                name="endpointUrl"
                type="url"
                required
                placeholder="https://your-server.example/v1/chat/completions"
                maxLength={2048}
              />
            </label>
            <label className="grid gap-2 text-sm">
              Новый секретный ключ
              <Input
                name="authToken"
                type="password"
                required
                autoComplete="new-password"
                maxLength={4096}
              />
            </label>
            <Button type="submit" disabled={busy}>
              Отправить новую версию
            </Button>
          </form>
        </section>
      )}
      {mode === "admin" &&
        model.current_author_version_id &&
        ["live", "frozen"].includes(model.status) && (
          <section className="rounded-xl border p-5">
            <h2 className="text-xl font-semibold">Остановить новые запросы</h2>
            <form
              className="mt-4 flex flex-col gap-3 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                void perform({
                  action: "status",
                  status: model.status === "frozen" ? "live" : "frozen",
                  reason: String(data.get("reason")),
                  expectedCurrentVersionId: model.current_author_version_id,
                });
              }}
            >
              <Input
                name="reason"
                required
                minLength={3}
                maxLength={500}
                placeholder="Причина остановки"
                aria-label="Причина остановки"
              />
              <Button
                type="submit"
                disabled={
                  busy || (model.status === "frozen" && !runtimeEnabled)
                }
                variant="outline"
              >
                {model.status === "frozen" ? "Возобновить" : "Заморозить"}
              </Button>
            </form>
            <p className="mt-3 text-sm text-muted-foreground">
              Ранее принятые запросы и их чеки сохраняются. Повторная генерация
              для восстановления результата не выполняется.
            </p>
          </section>
        )}
    </div>
  );
}
function VersionCard({
  model,
  version: v,
  mode,
  busy,
  enabled,
  perform,
}: {
  model: AuthorModelView;
  version: AuthorVersionView;
  mode: Props["mode"];
  busy: boolean;
  enabled: boolean;
  perform: (value: Record<string, unknown>) => Promise<void>;
}) {
  const [accepted, setAccepted] = useState(false),
    [probeSent, setProbeSent] = useState(false),
    [formError, setFormError] = useState("");
  const scope = { versionId: v.id, manifestDigest: v.manifest_digest };
  const current = model.current_author_version_id === v.id;
  const ready =
    ["draft", "live"].includes(model.status) &&
    v.probe_state === "succeeded" &&
    Boolean(v.accepted_at) &&
    Boolean(v.policy_id) &&
    ["candidate", "approved"].includes(v.status);
  async function propose(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError("");
    const data = new FormData(e.currentTarget);
    try {
      const days = Number(data.get("days"));
      if (!Number.isInteger(days) || days < 0 || days > 90)
        throw Error("Укажите срок удержания от0до90дней.");
      await perform({
        action: "propose",
        ...scope,
        priceMicrocredits: String(data.get("price")),
        authorShareBps: authorPercentToBps(String(data.get("share"))),
        availabilityDelaySeconds: days * 86400,
        rightsReference: String(data.get("rights")),
        consentReference: String(data.get("consent")),
      });
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "Проверьте условия.",
      );
    }
  }
  return (
    <section className="rounded-xl border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">Версия {v.version_no}</h2>
        <span className="text-sm text-muted-foreground">
          {current ? "Текущая · " : ""}
          {stateLabels[v.status] ?? v.status}
        </span>
      </div>
      <p className="mt-3 text-sm">
        {stateLabels[v.probe_state ?? ""] ?? "Подключение ещё не проверялось"}
      </p>
      {v.probe_state === "unknown" && (
        <p className="mt-2 text-sm text-amber-500">
          Нужна проверка оператора: автоматический повтор запрещён.
        </p>
      )}
      <dl className="mt-4 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-[130px_1fr]">
        <dt className="text-muted-foreground">Адрес API</dt>
        <dd className="break-all font-mono text-xs">
          {v.endpoint_url || "Не задан"}
        </dd>
        <dt className="text-muted-foreground">Отпечаток версии</dt>
        <dd className="break-all font-mono text-xs">{v.manifest_digest}</dd>
      </dl>
      {v.policy_id && v.price_microcredits !== null && (
        <div className="mt-5 rounded-lg border bg-muted/20 p-4">
          <h3 className="font-semibold">Зафиксированные условия</h3>
          <dl className="mt-3 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
            <dt className="text-muted-foreground">Цена для покупателя</dt>
            <dd>
              {formatAuthorCredits(v.price_microcredits)} кредита за запрос
            </dd>
            <dt className="text-muted-foreground">Доля автора</dt>
            <dd>{formatAuthorShare(v.author_share_bps ?? 0)}</dd>
            <dt className="text-muted-foreground">Удержание начисления</dt>
            <dd>{(v.availability_delay_seconds ?? 0) / 86400} дн.</dd>
            <dt className="text-muted-foreground">Проверенные права</dt>
            <dd className="break-all">{v.rights_reference}</dd>
            <dt className="text-muted-foreground">Условия согласия</dt>
            <dd className="break-all">{v.consent_reference}</dd>
          </dl>
          <p className="mt-3 break-all font-mono text-xs text-muted-foreground">
            {v.policy_digest}
          </p>
          {mode === "owner" && !v.accepted_at && (
            <div className="mt-4 space-y-3">
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                  className="mt-1"
                />
                Я принимаю цену, долю, срок удержания и указанные права
                использования этой версии.
              </label>
              <Button
                disabled={!accepted || busy}
                onClick={() =>
                  void perform({
                    action: "accept",
                    policyId: v.policy_id,
                    policyDigest: v.policy_digest,
                  })
                }
              >
                Принять условия
              </Button>
            </div>
          )}
          {v.accepted_at && (
            <p className="mt-3 text-sm">
              Автор подтвердил условия.{" "}
              {v.approved_at
                ? "Модерация завершена."
                : "Ожидается решение модератора."}
            </p>
          )}
        </div>
      )}
      {mode === "admin" && (
        <div className="mt-5 space-y-5">
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={
                busy ||
                probeSent ||
                Boolean(v.probe_state) ||
                v.status !== "candidate"
              }
              onClick={() => {
                setProbeSent(true);
                void perform({ action: "probe", ...scope });
              }}
            >
              Проверить подключение
            </Button>
            <Button
              disabled={busy || !enabled || !ready || current}
              onClick={() =>
                void perform({
                  action: "approve",
                  ...scope,
                  policyId: v.policy_id,
                  expectedCurrentVersionId: model.current_author_version_id,
                })
              }
            >
              Сделать текущей
            </Button>
          </div>
          {v.probe_state === "unknown" && !v.probe_reviewed && (
            <form
              className="space-y-3 rounded-lg border p-4"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void perform({
                  action: "review_probe",
                  ...scope,
                  evidenceReference: String(data.get("evidence")),
                });
              }}
            >
              <p className="text-sm">
                Разберите исход предыдущей проверки. Это не повторяет запрос и
                не делает версию одобренной. После разбора автор может отправить
                новую версию для новой проверки.
              </p>
              <label className="grid gap-2 text-sm">
                Основание разбора
                <Input
                  name="evidence"
                  required
                  minLength={3}
                  maxLength={1024}
                />
              </label>
              <Button type="submit" variant="outline" disabled={busy}>
                Зафиксировать разбор
              </Button>
            </form>
          )}
          {v.probe_reviewed && (
            <p className="text-sm text-muted-foreground">
              Исход разобран оператором. Эта версия не будет проверяться
              повторно.
            </p>
          )}
          {!v.policy_id && (
            <form
              onSubmit={propose}
              className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2"
            >
              <h3 className="font-semibold sm:col-span-2">
                Предложить автору условия
              </h3>
              <label className="grid gap-2 text-sm">
                Цена, микрокредиты
                <Input
                  name="price"
                  required
                  inputMode="numeric"
                  pattern="[1-9][0-9]*"
                  placeholder="Целое число"
                />
              </label>
              <label className="grid gap-2 text-sm">
                Доля автора, %
                <Input
                  name="share"
                  required
                  inputMode="decimal"
                  placeholder="От0до100"
                />
              </label>
              <label className="grid gap-2 text-sm">
                Удержание, дней
                <Input
                  name="days"
                  type="number"
                  min={0}
                  max={90}
                  step={1}
                  required
                />
              </label>
              <label className="grid gap-2 text-sm">
                Документ о правах
                <Input name="rights" required minLength={3} maxLength={512} />
              </label>
              <label className="grid gap-2 text-sm sm:col-span-2">
                Версия согласия
                <Input name="consent" required minLength={3} maxLength={512} />
              </label>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                1000 микрокредитов = 1 кредит. После предложения условия нельзя
                переписать: изменение требует новой версии и согласия автора.
              </p>
              {formError && (
                <p role="alert" className="text-sm sm:col-span-2">
                  {formError}
                </p>
              )}
              <Button type="submit" disabled={busy} className="sm:col-span-2">
                Зафиксировать предложение
              </Button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
