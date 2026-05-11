# Wave 08 — NFT Purchases via Startonus

**Goal:** Юзеры покупают NFT в Telegram Mini App. Платёж в TON через TON Connect, mint происходит асинхронно через Startonus webhook. Каталог коллекций и история покупок — наши.

**Architecture:** TMA показывает каталог NFT-коллекций (наша БД). При покупке backend дёргает `POST /api/minter/generate-invoice/custom` у Startonus с `secret` + параметрами шаблона, получает TON-транзакцию (`to`, `value`, `payload`) и отдаёт клиенту. Клиент подписывает через TON Connect. После подтверждения on-chain Startonus минтит NFT и шлёт POST на наш `callbackUrl` — webhook фиксирует mint, обновляет `nft_purchases.status='minted'` и пишет адрес NFT. Каталог + связки `template_id ↔ collection_address ↔ цена` админятся через `apps/web/admin`.

**Tech Stack:** Startonus REST API (single endpoint + webhook), TON Connect (Wave 05 wallet bridge), Drizzle/Postgres (каталог + история), Next.js app router в `apps/tg-miniapp`.

**Prereq:** Wave 01 (TMA scaffold), Wave 02 (initData auth), Wave 05 (TON Connect integration), Wave 06 (admin shell).

---

## Startonus API — зафиксированные факты

- **Base URL:** `https://bot.startonus.com/api`
- **Auth:** `secret` в теле каждого запроса (генерится bot-командой `/createMinterSecret` в @startonus_bot). Хранить в `/srv/aiag/shared/.env` как `STARTONUS_SECRET`.
- **Setup (вне HTTP API, через Telegram-бот):** `/createCollection` или `/importCollection` (Getgems) → конфиг mint-шаблонов → `template_id` из `/mintStats` или админки бота.
- **Единственный HTTP endpoint:**
  - `POST /api/minter/generate-invoice/custom`
  - Request: `{ id: number, address: string, secret: string, owner: {tgId, userName?, wallet}, referrers?, nftPrice (nano TON), nftAmount?, nftData? {name, description, image, content?, attributes?, buttons?}, callbackUrl?, userData? }`
  - Response: `{ id, to, value (nano TON), payload (base64), validUntil (unix s) }`
- **Webhook (callback):** Startonus шлёт POST на `callbackUrl`. Success — `{mintId, nft: {name, description, image, attributes, buttons}, ownerPayout, referrerPayouts, price, userData}`. Failure — `{mintId, error, message, userData}`. Идентификация — наш `userData` (мы кладём `purchase_id`).
- **Pricing:** TON only, nano TON (1 TON = 1e9). `nftPrice` обязателен. Реферальные комиссии 0.0–1.0 на участника.
- **Status query endpoint:** отсутствует — состояние трекаем только через webhook + (опционально) on-chain через TON Center API по `to`/payload.
- **Errors:** `invalid_body`, `price_too_low`, `amount_too_big`, `invalid_secret`, `unsupported_image_type`, `collection_not_found`, `mint_set_not_found`, `collection_not_ready`.
- **Rate limits:** не задокументированы — ставим клиентский throttle 5 req/s, на webhook idempotency по `mintId`.
- **Контент:** image — JPG/PNG/SVG/GIF/WebP (URL или base64). Video — MP4.
- **Swagger UI на `/api-docs` — заглушка (petstore demo)**, реальной OpenAPI спеки публично нет.

---

## File Map

| Action  | File                                                            | Purpose                                                   |
|---------|-----------------------------------------------------------------|-----------------------------------------------------------|
| Migrate | packages/database/migrations/0xxx_nft.sql                       | `nft_collections`, `nft_purchases` tables + indexes       |
| Create  | packages/database/src/schema/nft.ts                             | Drizzle schema + типы                                     |
| Create  | apps/tg-miniapp/src/lib/startonus.ts                            | Typed клиент `generateInvoice()` + Zod схемы              |
| Create  | apps/tg-miniapp/src/lib/nft-repo.ts                             | Репо: коллекции, история покупок, мутации статуса         |
| Create  | apps/tg-miniapp/app/nft/page.tsx                                | Каталог коллекций (server component)                      |
| Create  | apps/tg-miniapp/app/nft/[slug]/page.tsx                         | Детальный экран + кнопка Buy                              |
| Create  | apps/tg-miniapp/app/nft/[slug]/BuyButton.tsx                    | Client component: TON Connect + sendTransaction           |
| Create  | apps/tg-miniapp/app/nft/history/page.tsx                        | "Мои NFT" — список покупок юзера                          |
| Create  | apps/tg-miniapp/app/api/nft/purchase/route.ts                   | POST: создаёт `nft_purchases` (pending) + invoice         |
| Create  | apps/tg-miniapp/app/api/nft/webhook/route.ts                    | POST: принимает Startonus callback, обновляет статус      |
| Create  | apps/web/src/app/admin/nft/page.tsx                             | Admin CRUD: список коллекций                              |
| Create  | apps/web/src/app/admin/nft/[id]/page.tsx                        | Admin edit: template_id, address, price, image, активность|
| Modify  | apps/tg-miniapp/app/layout.tsx (bottom-nav)                     | Добавить таб "NFT"                                        |
| Modify  | apps/tg-miniapp/src/env.ts                                      | `STARTONUS_SECRET`, `STARTONUS_BASE_URL`, `PUBLIC_BASE_URL`|

---

## Task 1 — DB migration `nft_collections` + `nft_purchases`

DDL:

```sql
CREATE TABLE nft_collections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text UNIQUE NOT NULL,
  title          text NOT NULL,
  description    text,
  image_url      text NOT NULL,
  template_id    integer NOT NULL,           -- Startonus mint template id
  address        text NOT NULL,              -- TON collection address
  price_nano     bigint NOT NULL,            -- nano TON
  is_active      boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0,
  attributes     jsonb,                      -- override nftData.attributes
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nft_collections_active_idx ON nft_collections (is_active, sort_order);

CREATE TABLE nft_purchases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection_id  uuid NOT NULL REFERENCES nft_collections(id),
  startonus_id   text,                       -- invoice id (из response)
  mint_id        text,                       -- из webhook
  status         text NOT NULL DEFAULT 'pending',
                 -- pending|invoice_sent|paid|minted|failed|expired
  price_nano     bigint NOT NULL,
  tx_hash        text,
  wallet         text NOT NULL,              -- TON address юзера
  nft_address    text,                       -- адрес заминченного NFT
  error_code     text,
  error_message  text,
  webhook_payload jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nft_purchases_user_idx ON nft_purchases (user_id, created_at DESC);
CREATE UNIQUE INDEX nft_purchases_mint_id_uq ON nft_purchases (mint_id) WHERE mint_id IS NOT NULL;
```

Drizzle schema в `packages/database/src/schema/nft.ts`. Прогон миграции на VPS через существующий `npm run db:migrate` в prebuild.

## Task 2 — Startonus API client

`apps/tg-miniapp/src/lib/startonus.ts`:

- `generateInvoice(params)` — типизированная обёртка над `POST /api/minter/generate-invoice/custom`. Zod-валидация запроса и ответа. `secret` всегда из `env.STARTONUS_SECRET` (никогда не из клиента).
- Маппер ошибок Startonus → наши коды (`STARTONUS_PRICE_TOO_LOW`, `STARTONUS_INVALID_SECRET`, etc.) + лог в Sentry.
- Helper `tonToNano(amount)` / `nanoToTon(nano)`.
- Timeout 10s, 1 retry на 5xx с экспоненциальным backoff.

## Task 3 — NFT catalog UI (TMA)

- `/nft` — grid карточек активных коллекций из БД (server fetch). Skeleton + empty state.
- `/nft/[slug]` — hero image, title, описание, цена в TON, CTA "Купить за X TON". Если юзер не подключил кошелёк — fallback на `<TonConnectButton>`.
- Добавить вкладку "NFT" в bottom-nav (между чатом и профилем).
- Стилистика — из `ui-engineer` skill (PinGlass design system).

## Task 4 — Purchase flow (async mint)

1. `BuyButton` (client): берёт `wallet` из TonConnect → `POST /api/nft/purchase` `{collection_slug}`.
2. `POST /api/nft/purchase` (server):
   - auth через initData (Wave 02), берёт `tgId`/`userName`/`user.id`.
   - читает `nft_collections` по slug, проверяет `is_active`.
   - вставляет `nft_purchases` со статусом `pending`, генерит `purchase_id`.
   - вызывает `generateInvoice({ id: template_id, address, secret, owner:{tgId,userName,wallet}, nftPrice: price_nano, callbackUrl: PUBLIC_BASE_URL + '/api/nft/webhook', userData: purchase_id })`.
   - сохраняет `startonus_id`, переводит в `invoice_sent`, возвращает клиенту `{to, value, payload, validUntil}`.
3. Клиент шлёт через `tonConnectUI.sendTransaction({messages: [{address: to, amount: value, payload}], validUntil})`.
4. После подтверждения TON Connect — клиент пингует `/api/nft/purchase/[id]` (poll каждые 3s, max 2 мин) для UI-фидбека.
5. Параллельно Startonus вебхуком зальёт результат — см. Task 4b.
6. UI редиректит на `/nft/history` с подсветкой свежей покупки.

### Task 4b — Webhook handler

`POST /api/nft/webhook`:
- Никакой auth (Startonus не подписывает) → защищаемся через `userData = purchase_id` (uuid, неугадываемый) + проверка `mint_id` уникальности.
- Парсит payload, по `userData` находит `nft_purchases.id`.
- Success: `status='minted'`, `mint_id`, `nft_address` (из payload.nft), `webhook_payload`.
- Failure: `status='failed'`, `error_code`, `error_message`.
- Идемпотентность: если `mint_id` уже записан — `200 OK` без изменений.
- Логирование полного payload в JSONB колонку для аудита.

## Task 5 — Admin CRUD для коллекций

`apps/web/src/app/admin/nft/`:
- Index: таблица всех `nft_collections` (sort/active toggle inline).
- Create/Edit: форма с полями slug, title, description, image (S3 upload), `template_id`, `address`, `price_nano` (input в TON, конверсия на сабмите), `is_active`, `sort_order`.
- Защита через существующий admin RBAC.

## Task 6 — Smoke test full flow (на VPS)

После деплоя на ai-aggregator.ru:
1. Создать тестовую коллекцию через @startonus_bot (`/importCollection` с дешёвым шаблоном).
2. Засеять `nft_collections` в проде (1 запись через admin UI).
3. С тестового TG-аккаунта зайти в TMA → `/nft` → купить → подписать TON-транзакцию.
4. Проверить: запись `nft_purchases` прошла `pending → invoice_sent → minted`, webhook отработал, NFT появился в кошельке, страница `/nft/history` показывает покупку.
5. Negative-кейс: отменить транзакцию в кошельке → запись висит в `invoice_sent` → cron-задача (отдельный wave) пометит `expired` по `validUntil`.

---

## Open questions / follow-ups

- Webhook signing у Startonus отсутствует — рассмотреть IP-allowlist Startonus на nginx.
- Status query endpoint не существует — нужен reconciliation job, который по `tx_hash` ходит в TonCenter для зависших `invoice_sent` дольше 10 мин.
- RUB-оплата не поддерживается Startonus → отдельный wave (Cloudpayments → swap TON), не в скоупе Wave 08.
