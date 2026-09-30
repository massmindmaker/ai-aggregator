# Contest lifecycle runbook — перенесён в Arena

Этот runbook описывал конкурсы, которых в AI Aggregator больше нет. Конкурсный контур
выпилен из продукта 30.09.2026 (план
[`docs/superpowers/plans/2026-09-30-remove-contest-contour.md`](../../docs/superpowers/plans/2026-09-30-remove-contest-contour.md),
шаги 1–7; граница — [записка](../../docs/ecosystem/2026-09-30-contest-removal-boundary.md)).

**Рабочая версия:** `/home/bob/Projects/aiarena/docs/ops/runbook/contest-lifecycle.md`

В Aggregator остались и остаются: каталог моделей и авторская экономика —
начисление за продажу модели (`author_earnings` / `author_credit_ledger`), выплаты
(`api/admin/payouts/**`), KYC-гейт выплат и cron
`apps/worker/src/queues/finalize-earnings-cron.ts`. Публикация модели автором —
`/dashboard/models`. Это не конкурс, поэтому runbook конкурса сюда не относится.

Не восстанавливать конкурсный код в этом репозитории. Откат, если понадобится, —
тег `pre-contest-removal`.
