# UI-критика TMA по 108-балльной шкале + план улучшений — 2026-06-12

Свежий проход по интерфейсу (после redesign-A) по 6 фокусам запроса основателя: **детальнее · понятнее · проще · адаптивнее под все мобильные · профессионально-детально анимированнее · круче**. Сведено из 3 параллельных аудитов (построенный код + research best-practice 2026 + исходный интент из памяти). Референс качества: **Binance / Bybit** (основатель). Источники аудита держим в `[[2026-06-12-forensic-audit]]`, канон `[[2026-06-02-WHAT-WE-ARE-BUILDING]]`, токены `DESIGN.md`.

## Где мы сейчас (108, честно)
| Ось | Сейчас | Худшее в оси |
|---|---|---|
| Продукт | **65** | поле `budget_rub_monthly` торчит в 4/6 страниц; навигация /market vs /templates |
| UX (★ worst) | **52** | `confirm()` при удалении (ломает iOS-WebView); настройки агента ВСЕГДА в режиме правки; composer = однострочный input; дубли навигации |
| Дизайн | **70** | `tma-badge` (amber) вместо `tma-eyebrow` в Wallet/Account → расход amber не по канону; BottomNav active = только цвет, нет amber-индикатора |
| Полнота-vs-интент | **57** | выхолощена character-card (нет строки-характера, @автора, live-дота); забытое ядро: мультимодель, AI-builder, free-run, run-trace persistence |
| **Адаптивность** (новый фокус) | **50** | нет `safe-area-inset` (Dynamic Island режет верх); сегмент 4-таба переполняется на 360px без fade-маски; rail без правого padding |
| **Анимация** (новый фокус) | **55** | `aiag-*` недоиспользована: нет entrance на главных экранах, нет перехода между табами/сегментами, нет haptics, нет live-дота в инбоксе |

Траектория: продукт/тех растут (43→65), **UX и анимация — отстающие**, их и качаем.

## Binance / Bybit как референс — что АДОПТИРУЕМ (и где НЕ превращаемся в биржу)
Основатель любит Binance/Bybit. Берём их **ремесло**, не «биржевой» каркас (канон запрещает crypto-casino + character-first). Конкретно:
- **Плотность данных без перегруза** (Binance order-book/portfolio): прогрессивное раскрытие — карточка агента 3 уровня (видно → expand → detail-sheet). Применяем на Маркете и в инбоксе.
- **Mono-цифры везде, tabular-nums** (Bybit P&L): баланс/cost/токены/latency/ID — JetBrains Mono + `font-variant-numeric: tabular-nums`. Уже частично; добить.
- **Скорость и чёткость табов** (Binance bottom-tab): мгновенная смена + микро-переход контента, активный таб с индикатором (у нас — добавить amber-полоску).
- **Профессиональная тёмная подача данных**: спарклайны/мини-графики дохода, числовые дельты с цветным знаком (но цвет + знак, не только цвет). Дэшборд/Кошелёк — наш «биржевой» слой, тут Binance-стиль уместен и санкционирован (это вкладка Дэшборд по решению основателя).
- **Точная адаптивность** (Bybit на всех iPhone/Android): safe-area, 44px-тачи, нет горизонтального скролла, svh-юниты.
- **Полированная микроанимация**: stagger ленты, spring-нажатия, skeleton-shimmer, haptic-отклик — то, что делает Binance «дорогим».
- ⛔ **НЕ берём:** биржевой каркас как ГЛАВНУЮ (Агенты/Маркет = персонажи-первыми, не котировки), неон-казино палитру, мульти-CTA. Amber-дисциплина и character-card — нерушимы.

---

## ПЛАН — быстрые победы (≤30 мин, делаем первыми)
1. **`tma-badge` → `tma-eyebrow`** в `wallet/page.tsx:215` + `account/page.tsx:104` — вернуть amber по канону.
2. **`safe-area-inset-top`** в `globals.css:53`: `padding-top: calc(32px + env(safe-area-inset-top,0px))` — фикс Dynamic Island. + `padding-bottom` для home-indicator в `.tma-shell--with-nav`.
3. **Удалить локальную `fmtCredits`** в `wallet/page.tsx:55-62` → импорт из `@/lib/credits` (тот же класс бага, что чинили в RunTrace = цена ×100).
4. **`demoStats` динамически** в `market/page.tsx:289`: `demoStats={t.clone_count===0 && !t.avg_rating}` — реальные данные перестают выглядеть «демо».
5. **`aiag-fade-up` на header всех 5 экранов** + **live-дот в инбоксе** (`agents/page.tsx`: `live={a.last_status==='running'||'pending'}`) — мгновенный uplift «живости».
6. **BottomNav active-индикатор** (`globals.css`): `.tma-nav-item--active::before` amber-полоска 20×2px сверху — канон «active = amber indicator», + доступность.
7. **Чистка мусорных классов**: `tma-search` (`market:200`), `tma-trace-metric-val` (`RunTrace:116,118`) — не определены в globals.css.

## ПЛАН — крупные улучшения (часы, качают UX/анимацию)
- **К1. `confirm()` → bottom-sheet подтверждения** (`agents/[id]/page.tsx:449`). Архитектура `.tma-sheet`+scrim уже есть. КРИТИЧНО для iOS.
- **К2. View-режим настроек агента + textarea-composer** (`agents/[id]/page.tsx:336-341, 833`): убрать auto-`startEdit()`, показать read-only spec-strip + кнопку «Редактировать»; composer = `<textarea>` с автовысотой. Главный экран перестаёт «всегда редактироваться».
- **К3. Унификация навигации /templates → /market** (`dashboard/page.tsx:308,443` + redirect) — убрать дубли из форензика.
- **К4. Переход между сегментами/табами**: `key={tab}` + `aiag-fade-up` на контейнере секции — плавная смена вместо рывка (Binance-feel).
- **К5. Вернуть character-card сигнатуру** (`CharCard`/Маркет): строка-характер (`ctrait`), @автор, статы в mono (runs · ★ · цена), live-дот. Это главная потеря интента по gap-анализу.

## ПЛАН — адаптивность (под ВСЕ устройства)
- `svh`/`dvh` юниты для hero/чата (`100svh` стабильно); `overflow-x: clip` на app-root.
- Telegram **content safe area** (`--tg-content-safe-area-inset-*`) + системные `env(safe-area-inset-*)` суммой — для шапки и BottomNav.
- Сегмент-бар 4 таба (`globals.css:1804`): fade-маска справа `::after` linear-gradient — показать, что прокручивается.
- Rail (`globals.css:1480`): добавить `padding-right: 20px` — последняя карточка не режется.
- Hub-grid на ≤380px: медиа-запрос — уменьшить gap/шрифт ярлыков, чтобы «Шаблоны» не обрезалось.
- Все тач-цели ≥44px; интерактив ≥20px от левого края (не конфликтовать с iOS swipe-back).
- Вызвать `miniApp.ready()` первой строкой; слушать `viewport.isStable` перед relayout; haptic-карта (light/medium/success/error/selection).

## ПЛАН — профессиональная детальная анимация (CSS, без тяжёлых либ)
- **Stagger ленты** через `sibling-index()` (Chrome 137+) + nth-child fallback — каталог «оживает».
- **`@starting-style` + `allow-discrete`** для тостов/drawer/sheet — плавные enter/exit без библиотек.
- **`animation-timeline: view()`** для budget-bar и прогресса дохода — цифры «наполняются» при скролле (Binance-вайб).
- **Трёхфазный typing→streaming** в чате: точки → fade → amber pulse-курсор + prominent Stop.
- **Spring-нажатия** через `cubic-bezier(.34,1.56,.64,1)` на карточках; `:active scale(.97)`.
- **Haptics** (selection_change на свайпе провайдера, notification/success на пополнении/запуске).
- **Foil-sweep `mix-blend color-dodge`** ТОЛЬКО на featured-агентах — иерархия редкости без казино.
- Всё под `prefers-reduced-motion` (кроме live-дота — оставить статичным indicator).

## ЧТО ДОБАВИТЬ — забытое ядро (на экране нет, интент требует)
- **Строка-характер + статы + @автор + live-дот** на charCard (сигнатура).
- **Run-trace ledger** с persistence шагов/токенов/cost (DESIGN зовёт «сигнатурным компонентом»).
- **Предсказание цены ДО запуска** на карточке (сейчас estimateCost только post-run).
- **Мультимодель per-role** (чат/картинка/голос/зрение) — слоты в спеке агента.
- **AI-builder «из слов»** (NL→spec) — роута нет.
- **Free-first-run грант** — обещан, founder-gate открыт.
- **Tool-approve gate** — платный image_gen без per-call подтверждения.

## Якоря — НЕ нарушать при улучшениях
Amber только CTA/лого/live/featured (один на экран) · hairline 1px, hover=glow не тень · mono все цифры · character-card = НЕ icon-grid · status-pill = иконка+слово (не цвет/глиф один) · prefers-reduced-motion off-switch · token-only (ноль inline #hex/fontSize) · навигационный словарь заморожен (/agents=«Мои агенты», /templates→/market).

## Порядок исполнения
Быстрые победы (1 заход) → К1/К2 (UX-критичное, iOS) → адаптивность-пакет → анимация-пакет → character-card сигнатура → забытое ядро (по founder-приоритету). Каждый заход: typecheck зелёный + деплой + проверка на проде `app.ai-aggregator.ru/tg`.
