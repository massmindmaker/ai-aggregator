# Веб-версия агент-маркета `/agentmarket` — спрятана (2026-07-15)

## Что сделано
Веб-витрина `apps/web` `/agentmarket` (список + `/agentmarket/[id]`) снята с публичного доступа:
- пункт меню «Агенты» убран из `MainNavbar.tsx`;
- обе страницы отдают честный **404** (`notFound()` из `next/navigation`) вместо каталога/деталей;
- код каталога, компонентов и лежащего под ним `catalog.ts` **не удалён** — остаётся в репозитории для будущей доработки.

Это не редирект на `/` — 404 честнее сообщает «такой страницы нет», чем прятать недоделанную вещь за молчаливым отскоком.

## Почему
Решение основателя (2026-07-15): веб-версия агент-маркета не доделана (была собрана как быстрая витрина в сессии 2026-07-12 — 7 карточек из БД, публичный листинг + деталка, без полноценного флоу запуска/найма на вебе). Развивать будем постепенно, отдельным треком. До готовности — не показывать как рабочую фичу (правило `PRODUCT.md` / `CLAUDE.md`: «UI = reality», не показывать недоделанное как готовое).

## Затронутые файлы
- `apps/web/src/components/layout/MainNavbar.tsx` — пункт меню `{ title: 'Агенты', href: '/agentmarket' }` удалён из `mainMenu` (закомментирован факт, не код).
- `apps/web/src/app/(marketing)/agentmarket/page.tsx` — добавлен ранний вызов `notFound()` в начале `AgentMarketPage()` (перед реальной логикой — код ниже недостижим намеренно, компилируется, Next.js это штатный паттерн).
- `apps/web/src/app/(marketing)/agentmarket/[id]/page.tsx` — добавлен ранний вызов `notFound()` в начале `AgentMarketDetailPage()`, до чтения `params`/шаблона.
- `apps/web/src/app/(marketing)/agentmarket/not-found.tsx` — не менялся; это уже существовавший route-scoped 404-boundary, теперь он же обслуживает оба гейта.
- Код **не тронут**: `apps/web/src/components/agentmarket/AgentTemplateCard.tsx`, `apps/web/src/lib/agentmarket/catalog.ts` — используются только внутри `agentmarket/*`, снаружи на них никто не ссылается (проверено grep по `apps/web/src`).
- `docs/DASHBOARD.html` — добавлена одна строка-карточка в зоне «Обзор» (сессия 2026-07-15).

## Как вернуть
1. Убрать вызовы `notFound()` из `page.tsx` и `[id]/page.tsx` (по одному раннему `return`/вызову в каждом файле).
2. Вернуть пункт `{ title: 'Агенты', href: '/agentmarket' }` в `mainMenu` в `MainNavbar.tsx`.
3. Проверить `getPublicAgentTemplates()` / `getPublicAgentTemplateById()` в `apps/web/src/lib/agentmarket/catalog.ts` — данные могли устареть за время, пока раздел был скрыт.
4. Прогнать `bunx tsc --noEmit` + ручную проверку `/agentmarket` и `/agentmarket/<id>` на проде после деплоя.

## Не входит в объём этой правки
- TMA-версия агент-маркета (`apps/tg-miniapp`) — отдельный продукт, не затронута.
- Сам каталог/данные (`catalog.ts`) — не менялись, только доступ к рендерящим их страницам.
