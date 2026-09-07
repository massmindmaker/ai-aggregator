# AI Aggregator: начать разработку здесь

Канонический root: `/home/bob/Projects/ai-aggregator`. Прочитайте `AGENTS.md`, затем [общую рабочую карту](./consolidation/DEVELOPMENT-WORKFLOW.md), [границы активных проектов](./consolidation/ACTIVE-PROJECTS.md) и [журнал проверок](./consolidation/EXTRACTION-VERIFICATION.md).

## Текущее состояние

- Branch: `feat/three-projects-completion`; документ проверен на исходном HEAD `ed50ede`.
- Последний принятый кодовый этап: exact admission wrapper `1c25d0f` — 65 focused tests, source/test types и formatting прошли после review fix.
- Wrapper ещё не подключён к route/executor. Native driver integration, durable quota reservation, provider capability contract, authoritative usage receipt и reconciliation остаются обязательными до активации.
- Следующий продуктовый gate: заново проверить бизнес-процесс, user stories, UX и конкурентов. Текущие competitor/TON/protocol материалы — research и предложения, не одобренная реализация.

## Владение и следующий шаг

Aggregator владеет каталогом моделей, OpenAI-compatible gateway, consumer/author money и своим worker. Arena и Agents Market имеют отдельные корни; их активный код сюда не добавляется. Crypto-вариант Aggregator проектируется здесь и может использовать отдельный домен без четвёртого repository.

После утверждения продуктового направления следующий code increment должен иметь узкий Superpowers plan/brief, exact owner, tests и обязательный review. Не активировать admission, crypto/mainnet, production migration, paid provider или deploy на основании одного плана.

Размещение Aggregator приоритетно сохраняет существующий VPS. Vercel preview для текущей работы отменён до запуска; новых preview/deploy не создавалось.

## Память разработки

- Канонический handoff: этот файл, `docs/consolidation/*`, релевантный `docs/superpowers/plan` и приватный controller ledger `.superpowers/sdd/2026-09-06-three-repositories/progress.md`.
- Общая семантика: только принятые документы через LightRAG upload/sync. Приватный ledger, prompts, секреты и личные входные данные туда не загружаются.
- Код: Serena LSP index и локальный Graphify AST index. Они производные и не заменяют repo docs.
- Человеческая навигация: `/home/bob/brain/Projects/AI-Hub/README.md`.

Простой routing/операционную рутину отдавать лёгкой модели; серьёзный research, архитектуру и планирование — Astra с повышенным reasoning. Полная приёмка остаётся в scorecard и сквозных integration checks; текущий статус не равен `108/108`.
