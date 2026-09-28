# AG-P3 — авторская версия и доход

**Статус29.09: Batch B/C реализованы и прошли локальные native/browser-сценарии; независимое одобрение новой волны OPEN.** Точный [авторский checkpoint](../../consolidation/2026-09-29-author-lifecycle-checkpoint.md) содержит окончательные проверочные результаты и source commit. Это не production activation и не завершение всех этапов Aggregator.

Доказаны: проверка подключения с одним владельцем, неизменяемые условия и согласие автора, публикация точной версии, реальный mounted gateway, один расчёт/начисление, версии и rollback, полный возврат, долг после mock payout, спор, сохранённый расчёт после отзыва ключа, проверенное отсутствие списания без повторного вызова. Браузер проверил реальные формы и дополнительное подтверждение администратора; provider result подготовлен синтетически.

Статус 28.09.2026: **Batch A принят локально; AG-P3 в целом OPEN.** Source: `967dc74` в `feat/ag-author-version-20260928`. Это candidate submission, не продаваемая авторская модель и не release.

## Что доказано

- `POST /api/models/request-publish` принимает ограниченный manifest для HTTPS text chat endpoint, берёт author ID из серверной сессии, шифрует Bearer token до DB и атомарно создаёт выключенный `models` draft, candidate `author_model_versions` и audit. Цена/доля из браузера не становятся authority; token отсутствует в public manifest и `models.metadata`.
- Миграция `0087_author_model_versions.sql` добавляет immutable content, version identity и FK pointer на версию той же модели. Native fixture на одноразовой локальной БД проверил fresh **87 applied / 87 no-op**, duplicate version, malformed envelope, immutable update, foreign pointer и нулевой `author_earnings` ledger. Fixture удалён; исходная тестовая БД не мигрировала.
- Form показывает только поддержанный author-hosted HTTPS adapter и не обещает фиксированные 70/80/85%, цену или публикацию до модерации.

Проверки: author manifest **13/13**, HTTP boundary **5/5**, native migration **1/1**; shared/database/Web TypeScript exit0, shared+gateway+worker builds exit0, Next production build exit0 после исправления prebuild order, `git diff --check` exit0. Independent React, TypeScript/security и financial reviews — APPROVE без Critical/High. Первый полный Web prebuild упал до Next из-за отсутствующего `@aiag/api-gateway/batch-runtime` в чистом worktree; порядок сборки исправлен, gateway+worker и Next затем собраны отдельно.

## Исторический остаток на28.09 до реализации Batch B/C

1. Batch B: DNS/redirect/private-IP probe только через `safeFetch`, подтверждённые rights/consent, moderation CAS, current-version pointer, gateway admission pinning и один сохранённый авторский вызов/receipt. Candidate не выполняет внешние HTTP-запросы.
2. Batch C: versioned price/share policy, точное author accrual/reconciliation, refund/reversal и mock payout с crash/replay. Старый `author_earnings.model_id` указывает на `ai_models`, а warning-only settlement hook может терять начисление; до активации авторских моделей нужен отдельный financial gate.
3. Нет production migration/deploy, live provider probe, реальных денег или публичной продажи. После снятия публичной оферты и реквизитов юридический release gate остаётся открытым.

Owner plan: [AG-P3 Batch A–C](../../superpowers/plans/2026-09-28-ag-author-version-v1.md). Следующий исполняемый пакет — Batch B, затем Batch C; один green candidate test не закрывает AG-P3.


## Ревью безопасности 28.09 — не завершение AG-P3

Закрыты обход авторской модерации через legacy approve, отсутствие свежей проверки admin/step-up в пяти server actions и дефекты сетевой защиты Bun/Node. Финальный unit2625 PASS /485 SKIP, types/shared+gateway+worker+Web builds и scoped lint exit0; Bun local TLS mechanism smoke exit0. [Хендофф, точные границы и открытый dependency audit](../../consolidation/2026-09-28-aggregator-security-review.md). Durable probe/moderation/runtime pin/author earnings остаются незавершёнными. Свежей native-приёмки и независимого APPROVE в этой волне нет.


## Техническая совместимость после обновления зависимостей

Новая волна28.09 повторила author-version native1 на свежих87миграциях, общий DBbaseline388 и TON58; исправлены transaction-driver и распознавание WebDBproxy адаптером Auth.js. Реальные регистрация/вход/admin403, каталог/detail и mobile-overflow проверены в браузере. [Точный checkpoint](../../consolidation/2026-09-28-release-remediation-checkpoint.md). Это усиление foundations, не реализация durable probe/moderation/runtime pin/author earnings; AG-P3 остаётся OPEN. Независимого одобрения новой волны нет.

## Итог локального кандидата29.09

Source `ace7213d188269bcdbc5a6c845e01a6f6c54cd09`. Финальный unit2683PASS/500SKIP, native388 +TON58 +author16, два отдельных браузерных сценария, сборки/types/lint и audit0 подтверждены в [evidence](../../consolidation/2026-09-29-author-lifecycle-evidence.json). Независимая приёмка новой волны и production остаются OPEN.
