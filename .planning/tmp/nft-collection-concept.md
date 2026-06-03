# NFT-коллекция AI-Aggregator — «Знаки Первых Строителей»

> Концепт коллекционных NFT, продаваемых ВНУТРИ Telegram Mini App через Startonus + TonConnect.
> Все цифры (supply, цены, тиры) — **предложения**, а не обязательства.

---

## STEP 1 — Как продажа работает в реальном коде (grounded)

Прежде чем придумывать — вот фактическая механика, уже существующая в репозитории. Концепт ниже опирается именно на неё.

### Схема БД — `packages/database/migrations/0017_nft.sql`

**`nft_collections`** (каталог, управляется из админки):
- `id` UUID, `slug` (UNIQUE), `name`, `description`, `image_url`
- `startonus_collection_id` TEXT — ID коллекции, полученный из `@startonus_bot` командой `/createCollection`
- `price_nano_ton` BIGINT — цена минта в нано-TON (1 TON = 1e9 нано)
- `max_supply` INTEGER (NULL = безлимит), `minted_count` INTEGER (default 0)
- `status` VARCHAR — `draft / active / sold_out / archived`

**`nft_purchases`** (одна строка на попытку покупки):
- `collection_id` → FK на коллекцию
- `tg_user_id` BIGINT — **Telegram-юзер** (FK на `tg_users`, не `users`; TMA — основная поверхность)
- `startonus_invoice_id` TEXT — ID инвойса от Startonus
- `recipient_address` TEXT — TON-адрес кошелька (через TonConnect)
- `price_nano_ton` BIGINT — снимок цены на момент покупки
- `status` — жизненный цикл: `pending → paid → minted | failed | expired`
- `tx_hash`, `nft_address`, `error`, `created_at`, `paid_at`, `minted_at`

### Клиент Startonus — `packages/shared/src/startonus.ts`

- `BASE_URL = https://bot.startonus.com/api` (env `STARTONUS_BASE_URL`)
- `generateInvoice({ secret, collectionId, priceNanoTon, recipient, userData, callbackUrl })`
  → POST `/minter/generate-invoice/custom`
  → возвращает `InvoiceResponse { id, to, value, payload, validUntil }` — это уже **готовые параметры TonConnect-транзакции**.
- `userData` — мы кладём туда наш `purchase_id` (UUID) для матчинга вебхука.
- Хелперы: `tonToNano()`, `nanoToTon()`, `NANO_PER_TON`.
- Auth: секрет в теле запроса (env `STARTONUS_SECRET`), генерится через `@startonus_bot /createMinterSecret`.

### Полный поток покупки (фактический)

1. **Каталог** — `GET /tg/api/tma/nft/collections` (`app/api/tma/nft/collections/route.ts`) отдаёт только `status='active'` и не-распроданные (`max_supply IS NULL OR minted_count < max_supply`).
2. **UI деталки** — `app/nft/[slug]/page.tsx` (SSR из Postgres) + клиентский `BuyButton.tsx`.
3. **TonConnect** — `BuyButton` использует `@tonconnect/ui-react` (`useTonAddress`, `useTonConnectUI`). Без подключённого кошелька — `<TonConnectButton />`. Авторизация TMA — через `useAuth()` (Bearer-токен, открывать надо из `@aiag_bot`).
4. **Инициация** — `POST /tg/api/tma/nft/purchase` (`recipient_address`, `collection_slug`):
   - проверяет активную коллекцию + что supply не исчерпан (`409 sold_out`),
   - проверяет наличие `startonus_collection_id` (иначе `503 collection_not_configured`) и `STARTONUS_SECRET`,
   - вставляет `nft_purchases` со `status='pending'`, получает `purchase_id`,
   - зовёт `generateInvoice(..., userData=purchase_id, callbackUrl=${PUBLIC_BASE_URL}/tg/api/tma/nft/webhook)`,
   - сохраняет `startonus_invoice_id`,
   - возвращает `{ purchase_id, transaction: { validUntil, messages: [{ address, amount, payload }] } }`.
   - При ошибке Startonus — помечает покупку `failed` и отдаёт `502 minter_unavailable`.
5. **Подпись** — клиент зовёт `tonConnectUI.sendTransaction(body.transaction)`. Юзер подтверждает в кошельке → депозит уходит в minter Startonus.
6. **Минт (async)** — Startonus шлёт callback на `POST /tg/api/tma/nft/webhook`:
   - `invoice_paid|paid` → `pending → paid` (+ `tx_hash`, `paid_at`),
   - `minted` → в транзакции: `paid → minted` (+ `nft_address`) И `nft_collections.minted_count += 1`,
   - `failed|error` → `status='failed'`.
   - **Защита вебхука** (Startonus НЕ подписывает): (а) неугадываемый `purchase_id` UUID в `userData`, (б) nginx IP-allowlist, (в) идемпотентность — только forward-переходы.
7. **Админка** — создание коллекции: `apps/web/src/app/admin/nft/NewCollectionForm.tsx` → `POST /api/admin/nft/collections`. Поля: slug, name, description, image_url, **startonus_collection_id** (из бота), цена в TON (конвертится `tonToNano`), max_supply.

### Логотип AIAG (найден)

- **Бренд-компонент:** `apps/web/src/components/ui/AiagLogo.tsx` — оригинальный SVG (viewBox `0 0 32 32`).
- **Мотив:** 4 **амбер-круга** (`#f59e0b`), расставленных зигзагом (M-shape / граф), соединённых линиями — «сигнал, бегущий по графу». Порядок цепочки: нижний-левый (9,22, r=4.5) → верхний-middle (15,9, r=4.5) → нижний-правый (22,21, r=4.5) → маленькая верхняя-правая «точка отправки» (26,8, r=2.5). При `animated` свет последовательно пробегает по узлам (delay 0/300/600/900ms).
- **Растровая версия:** `apps/web/public/ai_logo_v1.png` (чёрный силуэт того же графа — 3 крупных узла + линии + 1 отдельный круг).
- Это и есть готовый «сигил» для печати на Знаке: узел-граф = сеть, амбер = фирменный акцент.

### Замечания по реализации (для команды, не для копирайтинга)

- **Гонка по supply.** Проверка `minted_count >= max_supply` в `purchase` происходит ДО минта, а инкремент — только на вебхуке `minted`. Между ними окно: можно создать N pending-инвойсов сверх лимита. Для маленьких тиражей (особенно «Founders») это критично — нужен либо резерв номера на этапе `pending` (атомарный `UPDATE ... SET minted_count = minted_count+1 WHERE minted_count < max_supply RETURNING`), либо учёт активных pending в проверке. **Рекомендация: добавить atomic reserve перед `generateInvoice`.**
- **Номер Знака.** Сейчас в схеме нет поля «порядковый номер NFT». Нумерация Startonus-минтом обычно идёт автоинкрементом item-index в коллекции, но если нужен гарантированный человекочитаемый № на картинке — это либо предгенерённые ассеты (URL по индексу), либо поле `serial_no` в `nft_purchases` + резерв.

---

## STEP 2 — КОНЦЕПТ

### 1. Название коллекции (2-3 варианта)

1. **«Знаки Первых Строителей»** (Marks of the First Builders) — *основной.*
   Премиса: пронумерованные реликвии Первого Города, которые помнят, кто пришёл ранним.
2. **«Хроника Ранних»** (The Early Chronicle)
   Премиса: не коллекция картинок, а запись — каждый Знак есть строка в Хронике, которая помнит.
3. **«Печати Первого Города»** (Seals of the First City)
   Премиса: печать на инфраструктуре, которую строят те, кому она принадлежит.

> Slug для БД (основной вариант): `znaki-pervyh-stroiteley` или короткий `marks-i` (для первой волны).

### 2. Что такое один NFT

Один NFT — это **один пронумерованный Знак**. В лоре:

> В мире недалёкого будущего ИИ — это инфраструктура, и она принадлежит тем, кто её строит. Платформа — Первый Город. Знак — не ключ и не контракт. Он ничего не сулит и ничего не открывает. Он **помнит**. На нём — печать графа (сигил Города) и номер: чем меньше номер, тем раньше пришёл носитель. Это строка в Хронике, которая помнит, кто был ранним.
>
> *Кто поймёт — тот поймёт.*

Технически: ончейн-айтем в TON-коллекции Startonus, на кошельке владельца. Картинка — сигил-печать с уникальным номером и визуальными отличиями по тиру.

### 3. Supply, нумерация, редкость / тиры (предложения)

Единая сквозная нумерация **#0001 … #1111**. Чем меньше номер — тем выше тир. Это делает редкость *читаемой без метаданных*: номер на самой печати.

| Тир | Номера (предложение) | Кол-во | Идея | Цена-ориентир (предложение) |
|-----|----------------------|--------|------|------------------------------|
| **Founders / Основатели** | #0001 – #0033 | 33 | Самый ранний когорт. Печать «горит» (полный амбер-glow), отдельный паттерн рамки. | 9–15 TON |
| **First Circle / Первый Круг** | #0034 – #0144 | 111 | Ранние строители. Полностью активный граф. | 3–5 TON |
| **Builders / Строители** | #0145 – #0511 | 367 | Основной тираж. | 1–2 TON |
| **Witnesses / Свидетели** | #0512 – #1111 | 600 | Финальная волна Хроники. Граф «спящий» (приглушённый). | 0.5–1 TON |

- **Итого supply: 1111** (предложение; «1111» как лор-число — «единицы, что были первыми»).
- Альтернатива поскромнее для тихого старта: всего **111** Знаков (#001–111), тир Founders #001–011. Легче гарантировать редкость и не растягивать продажи.
- В коде каждый тир = **отдельная `nft_collections`-строка** (свой `slug`, свой `startonus_collection_id`, свой `max_supply`, своя `price_nano_ton`), либо одна коллекция + предгенерённые ассеты с зашитым номером. **Рекомендация: тир = отдельная коллекция** — так `max_supply`-enforcement и ценообразование работают на существующем коде без доработок схемы.

### 4. Визуальное арт-направление (вокруг логотипа AIAG)

**Базовый мотив:** фирменный граф из 4 амбер-узлов (M-зигзаг + соединительные линии) = **сигил/печать Города**. Знак читается как реликвия-печать: круглый медальон/чеканка, в центре — граф-сигил, по кольцу — номер и микротекст-хроника.

**Визуальная система:**
- **Форма:** круглая печать (seal/coin), как восковая/металлическая чеканка. Тёмный фон (near-black `#0a0a0a` / графит), эмбоссированный рельеф.
- **Сигил:** граф AIAG в центре — 4 узла + линии. Амбер `#f59e0b` как свечение узлов/трасс.
- **Номер:** крупно гравирован — либо в центре под сигилом, либо по нижней дуге кольца («№ 0007 / 1111»). Шрифт — моноширинный/гротеск, как на бренде (`font-mono`).
- **Кольцевой микротекст:** по окружности — латиница/кириллица-хроника: «ПЕРВЫЙ ГОРОД · ХРОНИКА ПОМНИТ · КТО ПОЙМЁТ ТОТ ПОЙМЁТ».
- **Дифференциация редкости (читается глазом):**
  - *Founders* — печать золотится, узлы графа полностью «горят», двойная рамка-ободок, частицы/искры, рельеф глубже. Возможен holo/foil-эффект.
  - *First Circle* — полный амбер-граф, одинарная рамка, ровное свечение.
  - *Builders* — амбер приглушён до бронзы, граф ровный, без эффектов.
  - *Witnesses* — «спящий» граф: узлы тусклые, амбер уходит в серо-янтарный, печать матовая.
- **Анимация (если поддержим animated PNG/GIF/lottie на превью):** свет пробегает по узлам графа 0→1→2→3 (как в `AiagLogo` `animated`), у Founders — ярче и с послесвечением.

**Промпты для генерации (Kie nano-banana / Gemini Image / аналог):**

> **Prompt 1 — Founders seal:**
> "A circular embossed metal seal medallion on near-black graphite background, centered minimalist sigil of 4 connected amber-gold glowing nodes arranged in a zigzag M-shape graph with thin connecting lines (a signal traveling through a network), deep relief engraving, double ornamental ring border, large engraved serial number «№ 0007» in monospaced type along the lower arc, fine circular micro-text around the rim, molten amber glow #f59e0b on the nodes, sparks and gold foil accents, premium relic / ancient coin aesthetic, dark cinematic studio lighting, ultra sharp, 1:1."

> **Prompt 2 — Standard Builder mark:**
> "A circular dark bronze seal on charcoal background, centered sigil of four bronze nodes connected by thin lines forming a graph (network signal motif), single thin engraved ring, engraved serial number «№ 0231» in monospace along the bottom, subtle circular micro-text on the rim, muted amber-bronze tone #b4781f, matte metal, restrained minimalist relic, even soft lighting, 1:1."

> **Prompt 3 — Witness / sleeping graph:**
> "A matte dark seal coin, dim graphite surface, centered faint graph sigil of four barely-glowing greyish-amber nodes connected by thin lattice lines, low contrast, engraved number «№ 0903» small along the rim, quiet dormant atmosphere, weathered relic that 'remembers', no sparkles, muted desaturated palette, soft top light, 1:1."

> Постпроцесс: накладывать точный номер из набора (#0001…#1111) поверх сгенерённой базы каждого тира, чтобы цифры были чёткими и совпадали с ончейн item-index. База генерится 1 раз на тир, номер — программно (canvas/ffmpeg drawtext по `serial_no`).

### 5. Механика минта и продажи в TMA через Startonus (на реальном коде)

**Сетап (один раз на тир/коллекцию):**
1. В `@startonus_bot`: `/createMinterSecret` → положить в `STARTONUS_SECRET` (`/srv/aiag/shared/.env`).
2. `/createCollection` для каждого тира → получить `startonus_collection_id`; загрузить базовый арт/метадату тира на стороне Startonus (или раздавать `image_url` по item-index с нашего S3).
3. В админке `/admin/nft/new` (`NewCollectionForm`) создать коллекцию: `slug` (напр. `marks-founders`), name, description (лор), `image_url` (превью-печать тира), **`startonus_collection_id`**, цена в TON, `max_supply` = размер тира. Статус → `active`.

**Продажа (существующий поток, без изменений кода):**
- Юзер открывает TMA из `@aiag_bot` → вкладка **NFT** (`/nft`, `BottomNav`) → видит активные коллекции (каталог фильтрует распроданные).
- Деталка `/nft/[slug]` показывает печать, цену в TON, тираж `minted_count / max_supply`, блок «Как это работает».
- `BuyButton`: TonConnect-кнопка → после подключения «Купить за N TON» → `POST /tg/api/tma/nft/purchase` → `tonConnectUI.sendTransaction(transaction)` → «Транзакция отправлена, NFT поступит через 1–3 мин».
- Минт прилетает вебхуком → `minted_count++`, при достижении `max_supply` коллекция выпадает из каталога (фактически sold out).

**Enforcement supply (важно для маленьких тиров — доработка):**
- Сейчас лимит проверяется до минта, а инкремент на вебхуке → окно гонки. Для Founders (33 шт.) добавить **атомарный резерв** перед `generateInvoice`:
  `UPDATE nft_collections SET minted_count = minted_count + 1 WHERE id=… AND (max_supply IS NULL OR minted_count < max_supply) RETURNING minted_count` — и если 0 строк, отдавать `409 sold_out`. На `failed/expired` — компенсирующий декремент. (Либо считать активные `pending` в проверке.)
- Человекочитаемый номер: либо доверяем item-index Startonus, либо добавляем `serial_no` в `nft_purchases`, присваиваемый в момент резерва.

**Где в UI живёт:** нижняя навигация TMA → раздел **NFT** → каталог → деталка тира → минт. Плюс отдельная **лор-страница** (манифест, см. ниже), которая ведёт на каталог.

### 6. Лонч-стратегия (фазы)

**Фаза 0 — Манифест/лор-страница (до минта).**
Отдельный экран в TMA (или раздел деталки): текст-манифест Первого Города, рефрен «Кто поймёт — тот поймёт». В конце — мягкая кнопка «Посмотреть Знаки» → каталог. Никаких обещаний выгод, только лор. Манифест — единственная воронка; никакого «купи и получишь».

**Фаза 1 — Тихий дроп для ранних (Founders, #0001–#0033).**
- Без публичного анонса. Коллекция `marks-founders` ставится `active`, ссылка раздаётся узко — самым ранним/активным юзерам платформы (через DM-нотификации, которые уже есть в Phase 15).
- Малый тираж, выше цена (9–15 TON предложение). Смысл: «помечаем тех, кто был раньше всех».

**Фаза 2 — First Circle (#0034–#0144).**
Анонс в канале/боте. Цена 3–5 TON. Подсветить, что Founders уже разобраны (социальное доказательство ранности).

**Фаза 3 — Builders + Witnesses (открытый тираж).**
Публично, низкие цены (0.5–2 TON), объём. Хроника «дописывается» до #1111, после чего закрывается навсегда (`archived`).

**Ценообразование (предложение, не обязательство):** убывающая лестница по тирам (ранние дороже из-за дефицита и статуса ранности). Конкретные TON — выше в таблице тиров. Решение по числам — за основателем.

**Воронка:** манифест → ощущение причастности → каталог → минт. Дефицит и убывающая нумерация работают сами (виден `minted_count/max_supply`).

### 7. Юридическая безопасность

**Принцип:** Знак — это **коллекционный арт-объект (collectible)**, и он НЕ обещает НИЧЕГО. Это работает только если публичные тексты выдержаны строго в рамке «история/коллекция».

**Что можно говорить публично:**
- «Знак — пронумерованная коллекционная реликвия. Часть Хроники Первого Города.»
- «Он ничего не сулит, ничего не открывает и не даёт прав. Он помнит.»
- «Покупка — это минт коллекционного NFT за TON. Возврата нет (ончейн-транзакция).»
- Рефрен: «Кто поймёт — тот поймёт.» (нарратив, не оффер).

**Чего НЕЛЬЗЯ публично (нигде — ни в копирайтинге, ни в UI, ни в DM, ни в анонсах):**
- НЕ обещать и НЕ намекать на скидки, доступ, доли, доход, привилегии, утилити, airdrop, «бонусы ранним», «потом будет польза».
- НЕ называть Знак ключом, паем, контрактом, инвестицией, билетом.
- НЕ использовать формулировки, создающие ожидание выгоды или финансового возврата.

**Обязательный публичный дисклеймер (на лор-странице и деталке):**
> «Знак — это коллекционный цифровой арт-объект. Он не предоставляет никаких прав, доступа, утилити, доходности или гарантий и ничего не обещает. Покупка — минт коллекционного NFT за TON; транзакция необратима, возврат невозможен. Это история, а не оффер.»

> **Внутренняя заметка (НЕ для публичных материалов):** основатель вправе позже по своему усмотрению подарить реальные бонусы ранним держателям Знаков — но это **никогда** не должно быть обещано или подразумеваемо ни в одном публичном тексте, UI, анонсе или личке. Любая публичная привязка выгоды к Знаку ломает collectible-рамку и юридическую безопасность. Держим как «кто поймёт — тот поймёт».

---

*Все supply/цены/тиры — предложения к утверждению. Код-механика (Startonus generateInvoice → TonConnect → webhook mint) — реальная, по существующему репозиторию.*
