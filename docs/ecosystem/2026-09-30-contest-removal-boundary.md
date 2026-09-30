# Почему конкурсный контур удалён из Aggregator и где проходит граница

Дата: **30.09.2026**. Решение владельца: конкурсная площадка живёт в Arena, Aggregator
контур убирает. Это короткая записка о **причине**, **границе** и **откате**; механические
подробности шагов — в плане
[`docs/superpowers/plans/2026-09-30-remove-contest-contour.md`](../superpowers/plans/2026-09-30-remove-contest-contour.md).

## Причина

1. **Продуктовая.** У Aggregator нет собственного конкурсного трафика и автора:
   конкурс был маркетинговым входом в авторскую экономику, а не функцией, за которую
   платят. Конкурсная площадка по продуктовой модели — это Arena.
2. **Мёртвый код.** Контур в Aggregator никогда не работал, три независимых доказательства:
   - воркер-заглушка не писал результат оценки (`// TODO Phase 2: UPDATE evaluations …`)
     ⇒ `evaluations` и `public_score` пусты ⇒ лидерборд всегда был пуст;
   - `docs/launch-checklist.md:30`: чекбокс «First launch-contest prepared (dataset + prize
     pool + leaderboard UI)» не отмечен;
   - `close-contests-cron` делал `UPDATE contests SET status = 'closed'`, но значения
     `'closed'` нет в enum `contest_status` ни в `packages/database/src/schema/enums.ts`,
     ни в миграции `0005_contests.sql` — такой запрос упал бы с ошибкой типа, то есть
     конкурс не доходил до финализации и призы не начислялись.
3. **Данных нет — переносить нечего.** План требовал read-only pre-flight (шаг 0) перед
   любым кодом; переноса данных в волне не было, таблицы остались как есть.
   **Оговорка:** запись результата этого SQL в репозитории не найдена — если он не был
   выполнен, это нужно сделать перед любым `DROP TABLE` (см. ниже).
4. **Две финансовые сущности были смешаны в одном продукте.** Приз за конкурс и начисление
   автору за продажу модели — разные сущности с разной семантикой. Спека Phase 14 §3.6
   фиксирует это прямым текстом. Смешение в одном репозитории делало денежный контур
   сложнее, чем он есть.

## Граница: что удалено, что защищено

### Удалено из кода (шаги 1–7 выполнены)

| Область | Что удалено |
|---|---|
| Воркер | `contest-eval.ts`, `close-contests-cron.ts`, весь `eval-runner/**`, `contestEval` из `queues/names.ts` |
| API | 7 роутов: `contests/[slug]/{register,submit,leaderboard}`, `admin/contests/{,[slug],[slug]/status}`, `admin/contests/[slug]/publish-submission` |
| Схема | `contests.ts`, `evaluations.ts`, `prize-awards.ts` и их реэкспорты; `contestStatusEnum` из `enums.ts` |
| UI | `(marketing)/contests/**`, `admin/contests/**`, `dashboard/submissions`, `dashboard/wins`, `admin/moderation/submissions`, `(legal)/contest-host-agreement` |
| Навигация и тексты | пункт «Конкурсы» в `MainNavbar` и `CommandPalette`, `AdminSidebar`, `DashboardSidebar`, `OnboardingTour`, `sitemap.ts`, `admin/worker/page.tsx`, `dashboard/webhooks/page.tsx`, `smoke-shots.mjs` |
| Режим дашборда | `participant` — `lib/dashboard/mode.ts`, `roles.ts`, ветка в `overview.ts` |
| Контракт | `contestSubmissionId` в `packages/shared/src/author-manifest.ts` |
| Редиректы (301, `apps/web/next.config.mjs`) | `/contests` и `/contests/:path*` → `/marketplace`; `/admin/contests` и `/admin/contests/:path*` → `/admin`; `/contest-host-agreement` → `/author-agreement`; `/dashboard/submissions` и `/dashboard/wins` → `/dashboard`; `/admin/moderation/submissions` → `/admin/moderation/models` |

### Защищено — не тронуто

| Сущность / файл | Почему защищена |
|---|---|
| `author_earnings`, `payouts`, `author_tier_history` (`packages/database/src/schema/earnings.ts`) | начисление автора за **продажу модели**. `accrue_author_earnings` вешается на **каждый** вызов gateway; `finalize-earnings-cron.ts` ежедневно переводит начисления в `locked`. К конкурсу отношения не имеет |
| `api/admin/payouts/**`, `dashboard/earnings`, `dashboard/payouts`, `lib/payouts/tax.ts` | админские выплаты автору |
| `kyc_documents`, `admin/kyc-queue`, `dashboard/kyc` | KYC-гейт для выплат авторам (`payouts.kyc_snapshot`) |
| `models`, `ai_models`, `models-marketplace` | каталог — ядро Aggregator |
| TON (`ton-payments.ts`, `ton-payment-bootstrap.ts`), `api-gateway` | не связаны с конкурсом |
| `apps/worker/src/queues/finalize-earnings-cron.ts` | полностью неконкурсный |

Структурного пересечения `prize_awards` и `author_earnings` нет: первая FK-ится на
`contests`/`contest_submissions`, вторая на `users`/`ai_models`. `close-contests-cron`
писал **только** в `prize_awards` и ни в одну строку авторского начисления.

### Одно пересечение разведено, а не удалено

`api/admin/contests/[slug]/publish-submission` делал `INSERT INTO models (…, author_user_id,
derived_from_contest_id, …)` — то есть пересекался с каталогом. Вставка сохранена как
конкурсонезависимый админский роут **`POST /api/admin/models/from-submission`**
(`apps/web/src/app/api/admin/models/from-submission/route.ts`): тот же `INSERT` в `models`
от имени автора, но без `contest_id`/`final_rank`/top-K, с `derived_from_contest_id` = NULL.
Публикация из конкурса — забота Arena; продажа моделей остаётся в Aggregator.

Тексты `HomeFaq.tsx` и `page.tsx`, которые продавали «открытый конкурс → заявка →
автооценка → 70% автору», переписаны на публикацию через `/dashboard/models`: конкурс там
был бывшим входом, а продаётся авторская экономика.

## Почему таблицы в БД остались мёртвыми

`DROP TABLE` **не делался и не должен делаться в этом шаге**:

- миграция `0014_contest_marketplace.sql` добавила
  `models.derived_from_contest_id uuid REFERENCES contests(id) ON DELETE SET NULL` —
  `DROP TABLE contests` падает на этом FK, то есть удаление таблиц **задевает каталог
  моделей**, ровно то, что объявлено защищённым;
- `packages/database/migrations/README.md` запрещает `db:push` и автоматическую миграцию
  до достижения baseline схемы;
- `DROP TABLE` необратим без дампа, а код откатывается `git revert` за секунды.

Применённые миграции `0005_contests.sql` и `0014_contest_marketplace.sql` остаются
нетронутыми как историческая запись. Таблицы `contests`, `contest_participants`,
`contest_submissions`, `evaluations`, `evaluator_scripts`, `prize_awards` и enum
`contest_status` остаются в БД **сознательно мёртвыми**: приложение к ним больше не обращается.
Решение об их удалении — отдельная задача на стороне Arena, с дампом в руках.

## Откат

- **Тег `pre-contest-removal`** — точка отката. Каждый шаг выпиливания — отдельный коммит,
  поэтому точечный `git revert` вернуть любой шаг без затрагивания остальных.
- Тег стоит на `6eecef4` («восстановлены две конкурсные модели финансирования») —
  последний коммит до начала выпиливания.
- Коммиты шагов в этом worktree: `80026a6` (воркер), `96f2e47` (API), `737e461` (схема),
  `88e876d` (UI и тексты), `e039717` (навигация, режим `participant`, редиректы,
  `author-manifest.ts`), `d333319` (мост публикации).
- Данные откатывать не нужно: миграций данных не делалось.
- Откат **не требует** миграций БД, потому что `DROP TABLE` не выполнялся.

## Что Arena должна забрать

Переносить код нечего: Arena уже покрывает **8 из 12** конкурсных функций, и 6 из них
**строже**, чем было в Aggregator (policy с digest и заморозкой, регистрация с принятой
версией политики, команды и инвайты, immutable версии с тремя хешами, append-only отбор
с receipt, модерация).

Реально не хватает трёх вещей:

1. **Оценка с сохранением результата.** В Aggregator оценок не было: воркер выбрасывал
   результат. Спецификация поведения (как запускать закреплённую методику в изоляции) —
   бывший `eval-runner/runner.ts`, 157 строк; `systemd-run` в Arena неуместен, это
   образец поведения, а не готовый код.
2. **Лидерборд по score.** Сейчас `/leaderboard` в Arena ранжирует по числу активных
   записей, а не по оценке, — честно, но это активность, а не результат.
3. **Призы и выплаты.** `prize_awards` удалены из Aggregator, в Arena их нет.
   Финансовые модели — в [`CONTEST-FUNDING-MODELS.md`](./CONTEST-FUNDING-MODELS.md)
   (коммерческий конкурс с депозитами и комьюнити-конкурс с мем-токеном, отложенный
   владельцем). Требования Arena: AR-02, AR-07, AR-09 в
   `/home/bob/Projects/aiarena/docs/ecosystem/arena.md`, плюс план TON-призов.

Плюс публикация победившей версии: Arena инициирует, Aggregator исполняет через
`POST /api/admin/models/from-submission`. Общего идемпотентного HTTP-контракта
`POST /v1/publication-drafts` ещё нет — это открытая работа на границе, и без неё вместе
с авторскими моделями в `/v1/catalog` цикл «конкурс → продажа → доход» пока не замыкается.

**Не переносить баг:** логику `close-contests-cron` писать в Arena нельзя как есть —
`UPDATE contests SET status = 'closed'` упал бы с ошибкой типа, потому что значения
`'closed'` нет в enum `contest_status`. У Arena своя схема, статусы надо проверить свои.

Runbook конкурса перенесён: `/home/bob/Projects/aiarena/docs/ops/runbook/contest-lifecycle.md`.
Здесь, в Aggregator, по тому же пути осталась заглушка со ссылкой.

## Что осталось незакрытым на Aggregator

- `POST /v1/publication-drafts` не реализован.
- Авторские модели по-прежнему отсутствуют в `GET /v1/catalog` — прежний блокер, не связанный
  с конкурсом, но теперь он единственный барьер на пути к доходу автора.
- Мёртвые конкурсные таблицы в БД — осознанный долг, не дефект.
