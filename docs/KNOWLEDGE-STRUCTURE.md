# AIAG — Структура знания и топология проектов

> Как мы документируем проект. SoT продукта = `docs/canon/AIAG-CANON.md` (побеждает при конфликте). Обновлено 2026-07-07.

## Проекты (топология)

| Проект | Папка | Репо | Статус |
|---|---|---|---|
| Web-агрегатор | `aggregator/apps/web` (+`packages/`gateway) | монорепо `massmindmaker/aiag-marketplace` (ветка `master`) | live |
| TMA (Telegram агент-маркет) | `aggregator/apps/tg-miniapp` + `apps/agent-worker` | тот же монорепо (ветка `feat/r2-readiness`) | live |
| **Hermes** | `hermes/` (сосед, ОТДЕЛЬНЫЙ проект) | отдельный, НЕ в монорепо | AI-агент-рантайм; TMA подключается к нему как интерфейсу (connect-your-own, тест); работает на VPS `176.124.211.11:8642` |
| agent-market | `projects/agent-market` | `massmindmaker/agent-market` | мёртвый огрызок TMA-сплита (07-07, отстал 37 коммитов, не форк); re-seed из HEAD для будущего полиреп |
| aiag-web | `projects/aiag-web` | нет (`.git` отсутствует) | скаффолд Фазы-2 web-раскола, не начат |
| Дашборд прогресса | `aggregator/docs/DASHBOARD.html` | — | локальный HTML, не деплой/не репо |
| Видео | `aggregator/video/` (в .gitignore, не в репо) | — | промо-ролики AIAG: tmp_FINAL_80s.mp4 (финал 80с) + aiag-promo*/aiag-ascii; перенесено из hermes/ 2026-07-10; ранние исходники в brain |

Целевая архитектура (решение основателя 2026-07-07): **полиреп — 1 продукт = 1 репо**; ОТЛОЖЕНО (epic #8) до фикса денежных багов #4/#5.

## Сторы знания — куда за чем

| Слой | Стор | Триггер обновления |
|---|---|---|
| SoT продукта/модели/решений | Канон `docs/canon/AIAG-CANON.md` | продукт-решение → сперва сюда |
| Спеки/аудиты | `docs/specs/*` | новый спек |
| Дизайн-система | `DESIGN.md` + `docs/wireframes/` | смена системы |
| Код: карта/сессия/exec | Serena `.serena/memories/aiag_*` | после значимого кода |
| Код: AST-граф | graphify `graphify-out/` (локально, `graphify update .`, НЕ коммитить) | после кода |
| Ресёрч | LightRAG (тег `AIAG`; shared с PinGlass) | новый ресёрч |
| Сущности/связи | memgraph (`mcp__memory`) | смена сущностей |
| Быстрые факты/указатели | auto-memory `~/.claude/.../memory/MEMORY.md` | нетривиальный факт |

## Правила

- Конфликт → **канон побеждает**. Старьё НЕ удалять → метить `DEPRECATED → канон`.
- Порядок при продукт-правке: канон → memgraph-узел → auto-memory указатель.
- После кода: `graphify update .` + Serena-память.
- Новый ресёрч → LightRAG. Код → Serena + graphify. Сущности → memgraph.
- **Hermes = ОТДЕЛЬНЫЙ проект**: документировать в его собственной папке/репо, НЕ смешивать с монорепо-знанием.
