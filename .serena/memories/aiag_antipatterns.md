# AIAG — Антипаттерны (что НЕ делать)

> SoT-канон: `docs/canon/AIAG-CANON.md`. Этот файл — каталог повторяющихся ловушек. При конфликте побеждает канон.

## Деньги / отображение
- **Цена ×100 (money-display bug).** НЕ городить локальную `fmtCredits` в компоненте — это даёт сдвиг разряда (кредиты как $0.01 показываются ×100). ВСЕГДА импортировать единый форматтер из `@/lib/credits`. Любая локальная копия форматирования валюты = баг.
- **Незарегистрированный `model_slug` → margin-leak.** Новый default/template-слаг ОБЯЗАН существовать в прод-таблице `models`, иначе gateway тихо падает в OpenRouter (наценка теряется = утечка маржи). Использовать ТОЛЬКО namespaced слаги вида `anthropic/claude-sonnet-4-6`, `openai/gpt-4o-mini`. Голые слаги (`hermes-4-405b`) = «Unknown model» fallback. Сверять каждый новый слаг с прод `models` ДО деплоя.

## SQL
- **Ambiguous-column после JOIN (42702).** После добавления JOIN (например MCP-таблиц) неквалифицированная колонка (`updated_at`, `id`) ломает запрос с `column reference ... is ambiguous`. ВСЕГДА квалифицировать таблицей: `agents.updated_at`, `agents.id`. См. фикс HTTP500-открытия-агента (`mem:aiag_bugs`).
- Prepared statements only; атомарные деньги-операции = `UPDATE … WHERE <guard> RETURNING` (см. `SECURITY.md`).

## Деплой / инфра
- **pm2 jlist под non-root виснет/падает.** Процессы pm2 root-owned → запускать `sudo -n pm2 jlist` (не голый `pm2 jlist` под app-юзером).
- **`bun install` через VPN-прокси виснет.** Сетевой прокси (10809) блокирует резолв реестра → `bun install` зависает (это блокер repo-split Фазы 2). Использовать `bun install --offline` когда лок уже есть, либо ставить без прокси.
- **commit без typecheck-гейта.** НЕ коммитить/деплоить без зелёного `tsc`/build. «Done» = верифицировано (build green + проверка на VPS), не предположено.

## Продукт / витрина
- **Потёмкинские витрины.** НЕ показывать каталог/маркет как полный, если на проде 0 строк (`agent_templates` пуст). Либо засеять данные, либо честный empty-state. UI = реальность.
- **Доки врут-в-минус.** Старые доки (`user-workflows.md`, старый канон §8, `apps/agent-worker/CLAUDE.md`) помечают как not-built то, что УЖЕ построено (author-rent, MCP+OAuth, реконсилер, ton-proof, transfer, D-1 USD-кредиты). НЕ доверять старым статусам «not-built» — сверять с `docs/canon/AIAG-CANON.md` (§8 таблица истины) перед тем как что-то «достраивать».
