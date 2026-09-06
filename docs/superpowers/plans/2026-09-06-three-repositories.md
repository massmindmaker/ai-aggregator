# Три проекта: консолидация и автономное завершение

Спецификация: ../../ecosystem/README.md, уточнения пользователя 06.09: три папки/три репозитория, Agents Market Web и TMA отдельно, автономное исполнение.

## Global constraints

- Не терять ни tracked, ни dirty/untracked изменения. Сначала независимые копии и provenance; архивировать источники только после сверки.
- Рабочие корни: /home/bob/Projects/ai-aggregator, /home/bob/Projects/aiarena, /home/bob/Projects/agents-market.
- Git-ветки feature; никаких force push или удаления remote history. Локальные commit с явно заданной технической identity, если user.name/email отсутствуют.
- Отдельные backend ownership и данные продуктов. Web и TMA Agents Market имеют общий API и раздельные приложения.
- Один тяжёлый build/test на хосте: flock /tmp/ai-ecosystem-build.lock.
- Начисления, расходы, возвраты и публикации только с проверяемым эффектом. Production и платные API не являются тестовой средой.
- Исходный roadmap содержит сотни проверок; задачи разработки детализируются непосредственно перед соответствующей волной по фактическому коду. Ни один пункт не считается выполненным из-за готовности плана.

### Task 1: Инвентаризация и выбор источника

Files: /tmp/aiag-source-comparison.md, /tmp/agents-market-boundary.md, /tmp/arena-boundary.md.
Produces: base commits, dirty-file boundaries, app/package ownership, migration conflicts.
Verification: git metadata and file evidence; no source mutations.

### Task 2: Три самостоятельных репозитория

Consumes: Task 1 provenance.
Produces: независимые git roots с feature branches, product-specific package/CI/docs, явные архивные source pointers.
Steps: clone without shared object dependencies; overlay preserved current files; narrow active workspaces; export history/provenance before removing duplicate active code; verify git fsck, ownership and package resolution. Existing unrelated marketing/video/research kept in their own archival component paths.

### Task 3: Воспроизводимая baseline и P0

Produces: per-repo baseline test/build report and focused regression fixes; test DB isolated from production.
Aggregator first: payment → organization credits → paid gateway usage; Agents Market first: boundary/API catalogue/fail-closed; Arena first: submissions/evaluation persistence.
Each task gets a focused implementation brief, regression checks, commit and spec/code review.

### Task 4: Последующие продуктовые волны

Consumes: stable source boundaries, working baseline and task-specific contracts.
Execute ordered AG-W, AM-W (including WEB/TMA), AR-W queues from product plans. Split each wave into reviewable code tasks. Record per-check evidence and explicitly keep unverified production acceptance open.

### Task 5: Интеграция и выпуск

Consumes: functional artifact/usage/evidence contracts.
Produces: 14 integration scenarios, 108 checks per product, separate Web/TMA acceptance, operator recovery/runbooks. No release-readiness claim before fresh execution evidence.
