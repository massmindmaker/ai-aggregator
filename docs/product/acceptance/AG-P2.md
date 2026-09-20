# AG-P2 — public catalog acceptance

## Принятый локальный шаг: shared contract

13.09.2026 приняты `5466c34` + `a502f4c`: browser-safe `@aiag/shared/catalog-contract`, строгий schemaVersion1 DTO/parser, согласованный seek cursor, точные readonly TypeScript types и явно synthetic fixture. Независимое повторное TypeScript/spec review: PASS / APPROVE, H1–H3 закрыты.

Проверки: focused7; source и отдельные strict test types; shared build, явный package subpath import и emitted declaration assertions; применимый lint и diff-check — PASS. Рецензент дополнительно проверил cursor mismatch/underfilled контрпримеры, declarations и отсутствие запрещённых раскрываемых полей. Это source/fixture acceptance, не live provider evidence.

## Принятый локальный шаг: durable DB revision

`78f7e38` + `665a43b` приняты после независимого SQL/TypeScript PASS / APPROVE. Миграция0073 задаёт singleton/read authority и statement triggers; native-проверки подтверждают commit/rollback/no-op/concurrency, overflow/corruption, реальный admin apply и отсутствие влияния несвязанных операций. Cleanup выдерживает частичный post-commit сбой, сохраняет foreign sentinel, восстанавливает env и закрывает оба клиента.

Проверки: native9 + manifest13 =22, strict test types, database types, lint, formatting и diff-check — PASS. Финальный manifest применён на новой guarded loopback БД из `template0`:73 applied, затем0 applied/73 skipped; собственная БД удалена, общая test DB не сбрасывалась. Это локальная migration/source приёмка, не production.

## Принятый локальный шаг: exact catalog projection

`da0cb62` + `dd7f11e` приняты после independent financial/TypeScript PASS / APPROVE. Exact retail pricing, immutable runtime/key capture, revision/availability и strict policy seam используют принятую billing authority. Исправлены SQL-грамматика и ошибочная отдельная классификация нулевого тарифа.

Проверки: initial124 focused; после исправления unit20 и guarded native reader1, source/strict test types/lint PASS. Native проверка исполняет настоящий default PostgreSQL reader с непустым списком моделей, только читает guarded test DB и закрывает оба клиента. Это не mounted HTTP или consumer acceptance.

## Локальный HTTP consumer — 19 сентября

`c25cb8c`: AG-owned HTTP consumer и mounted producer contract проверены:134 focused PASS, native smoke4 PASS, source/test types, lint и gateway build PASS; отдельное GLM review без блокирующих замечаний. [Подробные границы](../../consolidation/2026-09-19-catalog-continuation.md). Это часть Task5, а не реальный consumer Agents Market.

## Открытые шаги

[Owner plan](../../superpowers/plans/2026-09-13-public-catalog-contract.md): полная совместная приёмка HTTP/native matrix остаётся OPEN. Сохранённый native mounted WIP доводится по [текущему checkpoint20.09](../../consolidation/2026-09-20-priorities-and-routing.md). `/v1/models` сохранён. Реальный Agents Market consumer и AG→AM integration остаются UNVERIFIED и выполняются после приоритетных работ Aggregator. Production, платные upstream и новые runtime settings не включались.


## Native mounted matrix — 20 сентября

Локальный test increment принят: raw bounds16/17,512/513 и huge fan-out; реальный delete/recreate deployment; frozen/config-unavailable; runtime stale cursor409; advisory GET→price change→POST с независимыми суммами4→18 microcredits. Новые quote/pricing snapshots используют свежие условия, старые admission/result/mapping/ledger и replay сохраняются. Настоящие Hono/auth/PostgreSQL/Redis, внешний provider подменён; никаких новых upstream вызовов.

Итог: native7/7 PASS, config5/5 PASS, strict test TypeScript/lint/diff-check PASS. Независимые TS и native GLM reviews, включая fixes, APPROVE. [Точные jobs, границы и следующий шаг](../../consolidation/2026-09-20-priorities-and-routing.md). Полный root DB baseline, combined release и настоящий AM consumer остаются OPEN; этот smoke не заменяет их.
