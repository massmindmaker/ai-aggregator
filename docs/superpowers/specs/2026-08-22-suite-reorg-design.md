# Спека: Suite-реорганизация AIAG (Фаза A)

> 2026-08-22 · v2 — упрощена по итогам ревью 108 (87 → см. коммит) · Ветка канона: `feat/r2-readiness`
> Фазы проекта: **A реорганизация** → B ресёрч → C доработка маркетплейса.

## 1. Суть

Код AIAG лежит в трёх копиях; канон один — монорепо `massmindmaker/aiag-marketplace` (`projects/aggregator`, ветка `feat/r2-readiness`). Делаем из него чистый suite из 3 проектов: локально — родительская папка с `core/` + зеркалами, на GitHub — два subtree-зеркала. Прод-деплой и разработка остаются в монорепо, CI не трогаем. После — «ничего лишнего».

## 2. Решения основателя (фиксация)

| Решение | Выбор |
|---|---|
| Стратегия разделения | Монорепо = канон; зеркала вместо настоящего полирепо |
| Раскладка диска | Родитель `projects/aggregator`, монорепо внутри как `core/` |
| GitHub-зеркала | Перезаписать `agent-market`; создать `ai-aggregator-web`; конкурсы — без репо |
| Проекты | `ai-aggregator` (маркет+модели) · `agent-market` (TMA + web-app) · `ai-contest` |
| Чистота | После реорганизации лишних файлов/папок не остаётся (§5) |

## 3. Целевая структура

```
projects/aggregator/                 ← родитель (НЕ git-репо), только README.md + 4 папки
├── core/                            ← МОНРЕПО [massmindmaker/aiag-marketplace]
│   ├── apps/web                     ← маркет+модели + web-app агент-маркета (/agentmarket) + конкурсы
│   ├── packages/api-gateway         ← API моделей :4000
│   ├── apps/tg-miniapp              ← агент-маркет TMA
│   ├── apps/agent-worker            ← рантайм ранов
│   ├── apps/worker                  ← общие sink'и (contest-eval, upstream-poll)
│   └── packages/*                   ← общие пакеты
├── ai-aggregator/                   ← ЗЕРКАЛО №1 [massmindmaker/ai-aggregator-web] ← subtree apps/web
├── agent-market/
│   ├── tma/                         ← ЗЕРКАЛО №2 [massmindmaker/agent-market] ← subtree tg-miniapp+
│   │                                   agent-worker + packages/shared
│   └── web-app/                     ← ПЛЕЙСХОЛДЕР: README-указатель на /agentmarket в core/apps/web
└── ai-contest/                      ← ПЛЕЙСХОЛДЕР: README-указатель (routes в apps/web + sink в worker)
```

Инварианты: `apps/*` НЕ переименовываются; CI/pm2/`/srv/aiag/*` без изменений; зеркала read-only с шапкой «канон → core»; выделение web-app/contest кодом — волны Фазы C.

## 4. Шаги (строго по порядку)

| Шаг | Действия | Проверка результата |
|---|---|---|
| W1 Git-подготовка | push `feat/r2-readiness` (a8cc474 + спека); тег `archive/pre-reorg-2026-08-22` на tip старого agent-market (63c270b); `master` пометить «заморожен» в README (без fast-forward) | `git status` чист; тег виден на remote |
| ⛔ ГЕЙТ | **Основатель: `gh auth login`** — единственное действие человека в фазе | `gh auth status` зелёный |
| W2 Экспорт уникального | 14 файлов из `aiag-web` (admin/nft, contests submissions, me/submit-model, theme) + 2 из старого `agent-market` (clone-route, CatalogNav): сверка с HEAD → недостающее влить коммитом `restore unique features from stale splits` | список экспорта приложен к коммиту |
| W3 Архивация дублей | `projects/aiag-web` → `projects/_archive/aiag-web-snapshot-2026-06-12`; старый клон `agent-market` удалить (история в GitHub) | в `projects/` нет активных дублей |
| W4 Переезд | `aggregator`→`aggregator-tmp`; создать родитель; перенести как `core/`; перерегистрировать Serena; переименовать ключ auto-memory (с бэкапом); `graphify update .`; grep-правка абсолютных путей | build web из `core` зелёный; Serena/память отвечают |
| W5 Зеркала | subtree-push в оба репо; локальные clone'ы; README-шапки READ-ONLY; README-плейсхолдеры `web-app/`, `ai-contest/`; `README.md` родителя — карта suite | зеркала = HEAD subtree; шапки на месте |
| W6 Гигиена | `core/CLAUDE.md` под новую топологию (убрать мёртвые ссылки, зафиксировать канон-ветку); `AGENTS.md` вычистить и закоммитить (решено: не удалять); `.agents/`, `.codex/` → `.gitignore` (решено); правка вранья в `apps/tg-miniapp/CLAUDE.md` («RUB-баланс» → USD-кредиты); `DASHBOARD.html` → 11 зон (табл. ниже) + CARD'ы аудита 2026-08-22 в зоны 2–3 | критерии §5 выполнены |

### Дашборд: 11 зон вместо 12 плоских вкладок

Карточки не удаляются — переносятся; протухшие получают бейдж `архив`. У каждой зоны строка «канон: где код».

| # | Зона | Из старых вкладок |
|---|---|---|
| 1 | 📊 Обзор suite (карта проектов, статусы, демо для заказчика) | Обзор + Функционал (заказчику) |
| 2 | 🛒 AI-Агрегатор (витрина, gateway/биллинг, P0–P2 борда) | Web·модели + часть Архитектура |
| 3 | 🤖 Agent-Market (подразделы TMA и Web-app, Hermes/найм/iNFT) | TMA·агенты + часть Архитектура |
| 4 | 🏆 AI-Contest (состояние, план выделения) | новая |
| 5 | ⚙️ Платформа (VPS/pm2/nginx, CI/CD, БД/миграции, безопасность) | Деплой/CI-CD |
| 6 | 💳 Деньги (кредитная модель, тарифы/markup, мосты, выплаты) | Монетизация Wave-1 |
| 7 | 🔬 Ресёрчи (конкуренты РФ, финмодель, Hermes/NFT/x402, Gonka) | Архитектура/Research + Gonka |
| 8 | 🎨 Дизайн и интерфейс (токены, wireframes Board A/B, UX-аудиты, мокапы) | Дизайн + UX |
| 9 | 📣 Упаковка (бренд, презентации, видео-архив) | Упаковка + Видео |
| 10 | 🗺️ Roadmap (фазы A/B/C, GSD, архив фаз) | Планирование GSD |
| 11 | 🧭 Решения основателя (лог вердиктов со ссылками на спеки) | новая |

## 5. Критерии приёмки

- [ ] `projects/aggregator` содержит ровно: `README.md`, `core/`, `ai-aggregator/`, `agent-market/{tma,web-app}/`, `ai-contest/`.
- [ ] В `projects/` нет активных дублей AIAG — только `_archive/`.
- [ ] Оба зеркала = HEAD своего subtree; READ-ONLY шапки на месте.
- [ ] Уникальные файлы дублей влиты в core или явно задокументированы как потерянные фичи.
- [ ] Build web из `core` зелёный; CI-файлы не изменены (diff пуст).
- [ ] Serena/auto-memory/graphify работают из `aggregator/core`; grep по конфигам core не находит старых абсолютных путей.
- [ ] `DASHBOARD.html`: 11 зон, все карточки сохранены, аудит 2026-08-22 — CARD'ами в зонах 2 и 3.

## 6. Риски и границы

| Риск | Митигация |
|---|---|
| Слом ссылок на старый путь | карта в README; grep-правки доков |
| Потеря истории agent-market | тег архива до перезаписи |
| Форк памяти Claude | бэкап ключ-папки до переименования |
| Зеркала отстают от канона | read-only; обновление вручную скриптом после значимых мержей |

Откат целиком: вернуть `core/` на прежний путь, снять зеркала — данные не теряются (всё в git).
Не входит: выделение web-app/contest кодом, изменения CI, P0-фиксы аудита (Фаза C), TMA-работы, ресёрч (Фаза B).
