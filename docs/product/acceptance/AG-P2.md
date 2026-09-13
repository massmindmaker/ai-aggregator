# AG-P2 — public catalog acceptance

## Принятый локальный шаг: shared contract

13.09.2026 приняты `5466c34` + `a502f4c`: browser-safe `@aiag/shared/catalog-contract`, строгий schemaVersion1 DTO/parser, согласованный seek cursor, точные readonly TypeScript types и явно synthetic fixture. Независимое повторное TypeScript/spec review: PASS / APPROVE, H1–H3 закрыты.

Проверки: focused7; source и отдельные strict test types; shared build, явный package subpath import и emitted declaration assertions; применимый lint и diff-check — PASS. Рецензент дополнительно проверил cursor mismatch/underfilled контрпримеры, declarations и отсутствие запрещённых раскрываемых полей. Это source/fixture acceptance, не live provider evidence.

## Открытые шаги

[Owner plan](../../superpowers/plans/2026-09-13-public-catalog-contract.md): Task2 durable DB revision, Task3 exact retail/availability projection, Task4 HTTP route/errors и Task5 AG-owned consumer/native acceptance ещё не приняты. `/v1/models` сохранён. Реальный Agents Market consumer и AG→AM integration остаются UNVERIFIED, пока Market на паузе. Production, платные upstream и новые runtime settings не проверялись и не включались.
