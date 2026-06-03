# План реализации: Provider-picker (BYOK через каталог) — первый срез

> Конкретный, хирургический план на основе `docs/specs/2026-06-03-next-function-design.md`
> и 4 read-only исследований (`docs/specs/research/feat-1..4`).
> Канон: `/CLAUDE.md` · Безопасность: `/SECURITY.md` · Деплой: skill `aiag-deploy` · Миграции: `packages/database/CLAUDE.md`.
>
> **Принцип:** достраиваем уже наполовину собранную ветку биллинга. Read-сторона (воркер `resolveUpstream` ветка A) УЖЕ на проде. Строим только **write-сторону + TMA-каталог + UI**. Денежный путь (`settleRun`, `isExternal`-семантику, цикл инструментов) НЕ трогаем.

---

## 0. Что строим (одна фраза)

В форме создания агента пользователь выбирает провайдера из каталога (OpenAI / Anthropic / OpenRouter / … / Custom URL), вводит свой ключ → ключ шифруется (AES-256-GCM, base64) и пишется в `agent_provider_credentials` → агенту проставляются `provider_id / auth_ref / model_id` (+ `base_url_override` для custom) → воркер (уже умеет) маршрутизирует прогон через выбранного провайдера.

Сознательно НЕ в первом срезе: редактирование подключения у существующего агента, удаление/ротация ключа, кнопка «проверить соединение» для каталожного пути, выпиливание старого `external_openai`-блока, мульти-ключи, Gonka-строка.

---

## 1. Точные файлы (создать / изменить)

### СОЗДАТЬ

| Файл | Назначение |
|---|---|
| `apps/tg-miniapp/app/api/tma/providers/route.ts` | TMA-авторизованный `GET` каталога провайдеров (TMA-копия web-эндпоинта, который сегодня живёт в чужом продукте `apps/web`). |
| `packages/database/migrations/0027_provider_catalog_verify.sql` | **Только если** проверка на проде покажет, что 0026 не применена. Тело = повтор идемпотентного 0026 (он `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`). Если 0026 применена — этот файл не нужен (см. §3). |

### ИЗМЕНИТЬ

| Файл | Изменение |
|---|---|
| `apps/tg-miniapp/app/api/tma/agents/route.ts` | В `POST`: новая ветка «провайдер из каталога» — шифрует ключ, INSERT в `agent_provider_credentials`, проставляет `agents.provider_id/auth_ref/model_id/base_url_override`. Транзакция `sql.begin`. |
| `apps/tg-miniapp/app/agents/new/page.tsx` | UI-пикер провайдера над/вместо блока «🌐 Свой агент»: `<select>` каталога → поле ключа (+ URL только для custom) → поле модели. Новый submit-путь. |

### НЕ ТРОГАЕМ (хирургичность — живой денежный путь)

- `apps/agent-worker/src/agent-runner.ts` — `resolveUpstream` ветка A уже всё делает (`:61-73`). Read-сторона готова.
- `apps/agent-worker/src/db.ts` — `loadProviderCredential` готов (`:98-130`); контракт `enc_key = base64` (`db.ts:96-97`).
- `settleRun`, `callWithFallback`, `isExternal`-семантика, аккумуляторы tool-fee — **ноль изменений**.
- Старый `external_openai`-блок и колонки — оставляем (legacy, на живом пути). Выпил — отдельным шагом после прод-проверки нового пути.

---

## 2. DB-миграция

**0026_provider_catalog.sql УЖЕ существует в репозитории** и создаёт всё необходимое: таблицы `providers` (8 сидов) + `agent_provider_credentials` + 4 nullable-колонки на `agents` (`provider_id`, `model_id`, `auth_ref`, `base_url_override`). Миграция идемпотентна (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `INSERT … ON CONFLICT DO NOTHING`).

**Новых DDL для первого среза НЕ требуется** — write-роут пишет только в уже определённые этой миграцией структуры.

**Единственное действие по БД = ПОДТВЕРДИТЬ, что 0026 физически применена на проде.** Прод-миграции ручные и без трекинга (`packages/database/CLAUDE.md`); приложение-роль `aiag` не может `ALTER` — DDL только через `sudo -u postgres psql aiag`.

### 2.1 Проверка на проде (read-only, безопасно)

```bash
# SSH на VPS (под VPN — через прокси, см. memory infra_ssh_vps_via_vpn_proxy)
sudo -u postgres psql aiag -c "\dt providers"
sudo -u postgres psql aiag -c "\dt agent_provider_credentials"
sudo -u postgres psql aiag -c "SELECT id,name,requires_base_url FROM providers WHERE enabled ORDER BY sort;"
sudo -u postgres psql aiag -c "\d agents" | grep -E 'provider_id|model_id|auth_ref|base_url_override'
```

Ожидаем: обе таблицы есть, 8 строк в `providers` (custom → `requires_base_url = t`), 4 колонки на `agents`.

### 2.2 Если 0026 НЕ применена — применить вручную (идемпотентно)

```bash
# Файл уже в репо на VPS после rsync/pull:
sudo -u postgres psql aiag -f /srv/aiag/web-repo/packages/database/migrations/0026_provider_catalog.sql
# Перепроверить пунктом 2.1.
```

> Не используем `db:push` / `db:migrate` против прода (запрещено — `packages/database/CLAUDE.md`). Только ручной `psql -f`.

### 2.3 DDL-стейтмент целиком (для справки — то, что применяется)

См. `packages/database/migrations/0026_provider_catalog.sql`. Ключевое:

```sql
CREATE TABLE IF NOT EXISTS providers (
  id VARCHAR(64) PRIMARY KEY, name TEXT NOT NULL, api_base TEXT,
  auth_kind VARCHAR(16) NOT NULL DEFAULT 'api_key', enabled BOOLEAN NOT NULL DEFAULT true,
  requires_base_url BOOLEAN NOT NULL DEFAULT false, sort INT NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT providers_auth_kind_chk CHECK (auth_kind IN ('api_key'))
);
-- + INSERT 8 seeds ON CONFLICT (id) DO NOTHING
CREATE TABLE IF NOT EXISTS agent_provider_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider_id VARCHAR(64) NOT NULL REFERENCES providers(id),
  base_url TEXT, model_id TEXT,
  enc_key TEXT NOT NULL,         -- AES-256-GCM blob, base64 (контракт db.ts:96-97)
  key_hint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id)
);
CREATE INDEX IF NOT EXISTS idx_apc_agent_id ON agent_provider_credentials(agent_id);
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS provider_id       VARCHAR(64) REFERENCES providers(id),
  ADD COLUMN IF NOT EXISTS model_id          TEXT,
  ADD COLUMN IF NOT EXISTS auth_ref          UUID,
  ADD COLUMN IF NOT EXISTS base_url_override TEXT;
```

---

## 3. TMA-эндпоинт каталога — `GET /tg/api/tma/providers`

**Файл (новый):** `apps/tg-miniapp/app/api/tma/providers/route.ts`

TMA-копия web-эндпоинта (`apps/web/src/app/api/providers/route.ts:30-58`), но с TMA-авторизацией (`x-tma-user-id` от nginx) и драйвером `postgres` (как остальные TMA-роуты, `prepare:false`). Возвращает только включённые провайдеры.

```ts
import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface ProviderRow {
  id: string;
  name: string;
  api_base: string | null;
  auth_kind: string;
  requires_base_url: boolean;
}

export async function GET(req: NextRequest) {
  // nginx strips spoofable x-tma-user-id and re-injects it from the verified JWT
  // (/SECURITY.md). Same auth gate as every other /tg/api/tma route.
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const rows = (await sql`
    SELECT id, name, api_base, auth_kind, requires_base_url
    FROM providers
    WHERE enabled = true
    ORDER BY sort ASC
  `) as unknown as ProviderRow[];

  const providers = rows.map((r) => ({
    id: r.id,
    name: r.name,
    apiBase: r.api_base,
    authKind: r.auth_kind,
    requiresBaseUrl: r.requires_base_url,
  }));
  return NextResponse.json({ providers });
}
```

Заметки:
- **Prepared statement** (tagged-template `sql\`…\``) — соответствует правилу SQL.
- Авторизация обязательна (в отличие от web-версии без auth) — TMA-каталог сидит за `/tg` и должен следовать общему гейту.
- Белый-лейбл: эндпоинт отдаёт только пользовательские провайдеры (OpenAI/Anthropic/…); upstream-бренд нашего шлюза (OpenRouter/Kie за `:4000`) тут НЕ светится — он не строка каталога, а внутренний дефолт.

---

## 4. Write-роут — расширение `POST /tg/api/tma/agents`

**Файл:** `apps/tg-miniapp/app/api/tma/agents/route.ts`

Добавляем третий взаимоисключающий путь подключения рядом с `aiag` (дефолт) и `external_openai` (legacy). Дискриминатор тела запроса — наличие `provider_id`.

### 4.1 Расширить тип тела

```ts
interface CreateBody {
  // …существующие поля без изменений…
  // Provider-catalog path (migration 0026) — НОВОЕ:
  provider_id?: string;       // id из GET /tg/api/tma/providers
  provider_api_key?: string;  // сырой ключ пользователя (шифруется, не хранится в открытом виде)
  provider_model_id?: string; // upstream-модель у провайдера
  provider_base_url?: string; // только для провайдера с requires_base_url=true (custom)
}
```

### 4.2 Ветка записи (вставить ПОСЛЕ блока `external_openai`, ПЕРЕД INSERT агента)

Логика — зеркало уже существующего паттерна шифрования (`encryptSecret`/`hintFromSecret`/`validateExternalUrl`, `route.ts:97-102`). Контракт хранения `enc_key` ОБЯЗАН быть `encryptSecret(key).toString('base64')` — иначе воркер не расшифрует (`db.ts:96-97, :127`).

```ts
// ---- Provider-catalog path (migration 0026) ----
// Mutually exclusive with the legacy external_openai path. Discriminator: provider_id present.
let catalogProviderId: string | null = null;
let catalogModelId: string | null = null;
let catalogBaseUrlOverride: string | null = null;
let credEncKeyB64: string | null = null;   // base64 — contract with worker db.ts:96-97
let credKeyHint: string | null = null;
let credBaseUrl: string | null = null;

const wantsCatalog = typeof body.provider_id === 'string' && body.provider_id.trim().length > 0;
if (wantsCatalog && connectionType === 'external_openai') {
  return NextResponse.json({ error: 'connection_conflict' }, { status: 400 });
}
if (wantsCatalog) {
  const pid = body.provider_id!.trim().slice(0, 64);
  const key = body.provider_api_key?.trim() ?? '';
  if (!key) return NextResponse.json({ error: 'provider_api_key_required' }, { status: 400 });

  // Validate provider exists + is enabled; read requires_base_url from the catalog (not the client).
  const prov = (await sql`
    SELECT id, requires_base_url FROM providers WHERE id = ${pid} AND enabled = true LIMIT 1
  `) as unknown as Array<{ id: string; requires_base_url: boolean }>;
  if (!prov[0]) return NextResponse.json({ error: 'unknown_provider' }, { status: 400 });

  if (prov[0].requires_base_url) {
    const burl = body.provider_base_url?.trim() ?? '';
    if (!burl) return NextResponse.json({ error: 'provider_base_url_required' }, { status: 400 });
    // SSRF pre-flight — same guard the legacy external path uses (https-only, block
    // loopback/RFC1918/metadata). The worker's safeFetch is the load-bearing runtime
    // guard; this is the cheap early reject. NEVER add a user host to any allowlist.
    const guard = validateExternalUrl(burl);
    if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: 400 });
    catalogBaseUrlOverride = burl.replace(/\/+$/, '');
    credBaseUrl = catalogBaseUrlOverride;
  }

  catalogProviderId = pid;
  catalogModelId = body.provider_model_id?.trim() || null;
  credEncKeyB64 = encryptSecret(key).toString('base64'); // base64 → matches worker decode
  credKeyHint = hintFromSecret(key);
}
```

### 4.3 Транзакция: вставить агента → вставить credential → проставить auth_ref

Запись ключа + апдейт агента — в одной транзакции (`sql.begin`). Порядок: INSERT агента (получить `id`) → INSERT credential (получить `cred.id`) → UPDATE агента `auth_ref = cred.id`. Это снимает циклическую зависимость (`auth_ref` — soft-FK, заполняется после создания credential — комментарий `0026:95-98`).

```ts
if (catalogProviderId) {
  const created = await sql.begin(async (tx) => {
    const a = (await tx`
      INSERT INTO agents (
        tg_user_id, template_kind, name, description,
        system_prompt, tools, model_slug, budget_rub_monthly,
        connection_type, provider_id, model_id, base_url_override
      ) VALUES (
        ${tgUserId}::bigint, ${templateKind}, ${name}, ${description},
        ${systemPrompt}, ${sql.json(tools as never)}, ${modelSlug}, ${budget},
        'aiag', ${catalogProviderId}, ${catalogModelId}, ${catalogBaseUrlOverride}
      )
      RETURNING id::text, tg_user_id::text, template_kind, name, description,
                system_prompt, tools, model_slug, budget_rub_monthly::text,
                status, created_at, updated_at, provider_id, model_id
    `) as unknown as AgentRow[];
    const agentId = a[0].id;

    const c = (await tx`
      INSERT INTO agent_provider_credentials
        (agent_id, provider_id, base_url, model_id, enc_key, key_hint)
      VALUES
        (${agentId}::uuid, ${catalogProviderId}, ${credBaseUrl}, ${catalogModelId},
         ${credEncKeyB64}, ${credKeyHint})
      RETURNING id::text
    `) as unknown as Array<{ id: string }>;

    await tx`UPDATE agents SET auth_ref = ${c[0].id}::uuid WHERE id = ${agentId}::uuid`;
    return a[0];
  });
  return NextResponse.json({ agent: created }, { status: 201 });
}
// …existing INSERT for aiag / external_openai path stays unchanged below…
```

Заметки:
- `connection_type` остаётся `'aiag'` (CHECK допускает только `'aiag'|'external_openai'`, `0022`); дискриминатор воркера — `provider_id IS NOT NULL` (ветка A, «самое специфичное первым»). Это корректно: ветка A проверяется раньше `external_openai` (`agent-runner.ts:61` vs `:75`).
- Все стейтменты — prepared (tagged-template). Сырой ключ нигде не логируется; ответ возвращает агента без `enc_key` (его нет в `RETURNING`).
- `requires_base_url` читаем из каталога БД, НЕ из клиента — клиент не может навязать «custom»-поведение брендовому провайдеру.

### 4.4 Биллинговая семантика (зафиксировать перед UI-обещанием «бесплатно»)

Каталожный путь сегодня = `isExternal:false` (`agent-runner.ts:71`) → **биллится через нас**. «Свой ключ = 0 комиссии» в чистом виде живёт на ветке `external_openai` (`isExternal:true`). Первый срез даёт **выбор провайдера + сохранение ключа**; он НЕ объявляет в UI «бесплатно» для каталожного BYOK. Развилка «каталожный BYOK = 0 комиссии?» — **founder-level решение по деньгам** (см. `next-function-design.md` §«Развилка для основателя»). Срез её НЕ предрешает и НЕ меняет `isExternal`-семантику воркера.

---

## 5. UI — пикер в `apps/tg-miniapp/app/agents/new/page.tsx`

Добавляем блок «Провайдер из каталога» НАД существующим блоком «🌐 Свой агент». Два режима взаимоисключающи (radio-логика: включил каталог → выключается `useExternal`, и наоборот) — чтобы не было двух способов одновременно.

### 5.1 Состояние (рядом с существующим `useExternal`-блоком, `:31-41`)

```ts
// Provider-catalog path (migration 0026)
const [providers, setProviders] = useState<
  { id: string; name: string; apiBase: string | null; requiresBaseUrl: boolean }[]
>([]);
const [useCatalog, setUseCatalog] = useState(false);
const [provId, setProvId] = useState('');
const [provKey, setProvKey] = useState('');
const [provModel, setProvModel] = useState('');
const [provBaseUrl, setProvBaseUrl] = useState('');
```

### 5.2 Загрузка каталога (новый `useEffect`)

```ts
useEffect(() => {
  if (!token) return;
  fetch('/tg/api/tma/providers', { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => (r.ok ? r.json() : { providers: [] }))
    .then((j) => setProviders(j.providers ?? []))
    .catch(() => setProviders([]));
}, [token]);

const selectedProvider = providers.find((p) => p.id === provId);
```

### 5.3 Разметка (вставить перед блоком «🌐 Свой агент», `:313`)

- Чекбокс «🔌 Провайдер из каталога» (взаимоисключающий с `useExternal`).
- `<select>` провайдеров (`providers.map`), дизайн-токены `var(--bg-surface)` / `var(--line)` / focus = amber ring (DESIGN.md «Provider picker»).
- Если `selectedProvider?.requiresBaseUrl` → показать поле URL (`type="url"`).
- Поле API key (`type="password"`, `autoComplete="off"`).
- Поле модели (`type="text"`).
- **Подсказка комиссии НЕ обещает «0 комиссии»** для каталожного пути на первом срезе (см. §4.4). Нейтральный текст: «Свой ключ к выбранному провайдеру».

```tsx
<label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
  <input
    type="checkbox"
    checked={useCatalog}
    onChange={(e) => { setUseCatalog(e.target.checked); if (e.target.checked) setUseExternal(false); }}
  />
  <span className="tma-card-text" style={{ fontWeight:600 }}>🔌 Провайдер из каталога</span>
</label>
{useCatalog && (
  <>
    <select value={provId} onChange={(e) => setProvId(e.target.value)} style={inputStyle} required>
      <option value="">— выбери провайдера —</option>
      {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
    {selectedProvider?.requiresBaseUrl && (
      <input type="url" value={provBaseUrl} onChange={(e) => setProvBaseUrl(e.target.value)}
             placeholder="https://example.com/v1" style={inputStyle} required />
    )}
    <input type="password" value={provKey} onChange={(e) => setProvKey(e.target.value)}
           placeholder="sk-…" autoComplete="off" style={inputStyle} required />
    <input type="text" value={provModel} onChange={(e) => setProvModel(e.target.value)}
           placeholder="например: gpt-4o-mini" style={inputStyle} />
  </>
)}
```

(Симметрично: в `onChange` чекбокса «🌐 Свой агент» добавить `if (e.target.checked) setUseCatalog(false);`.)

### 5.4 Submit (расширить тело в `handleSubmit`, `:121-133`)

```ts
body: JSON.stringify({
  template_kind: pickedKind,
  name: name.trim(),
  system_prompt: systemPrompt.trim(),
  model_slug: modelSlug.trim() || undefined,
  tools,
  budget_rub_monthly: budget,
  // legacy external path:
  connection_type: useExternal ? 'external_openai' : 'aiag',
  external_base_url: useExternal ? extBaseUrl.trim() : undefined,
  external_api_key: useExternal ? extApiKey.trim() : undefined,
  external_model_slug: useExternal && extModelSlug.trim() ? extModelSlug.trim() : undefined,
  // provider-catalog path (NEW):
  provider_id:        useCatalog ? provId : undefined,
  provider_api_key:   useCatalog ? provKey.trim() : undefined,
  provider_model_id:  useCatalog && provModel.trim() ? provModel.trim() : undefined,
  provider_base_url:  useCatalog && provBaseUrl.trim() ? provBaseUrl.trim() : undefined,
}),
```

---

## 6. Безопасность (чек-лист соответствия `/SECURITY.md`)

- **SSRF / safeFetch:** любой пользовательский URL (только `custom`-провайдер) проходит `validateExternalUrl` на write-роуте (cheap pre-flight: https-only, блок loopback/RFC1918/metadata). **Несущая защита — рантайм:** воркер гонит ВСЕ upstream-вызовы через `safeFetch` с `allowlist = SAFE_FETCH_ALLOWLIST` (`agent-runner.ts:193-198`), где user-host'ов НЕТ → полная DNS+IP-валидация + пин сокета + ре-валидация редиректов. **User-host НИКОГДА не добавлять в allowlist.** Брендовые провайдеры (OpenAI/Anthropic/…) base_url берётся из каталога БД, не от клиента → не пользовательский URL.
- **Шифрование ключа:** `encryptSecret(key).toString('base64')` (AES-256-GCM, контракт `db.ts:96-97`). Сырой ключ не логируется, не возвращается в ответе (нет в `RETURNING`). UI хранит ключ только в локальном state до сабмита; в БД — только ciphertext + `key_hint` (последние 4, `***abcd`).
- **White-label:** каталог содержит только пользовательские провайдеры; upstream-бренд нашего шлюза (OpenRouter/Kie за `:4000`) не светится в каталоге и не в ошибках. Ошибки роута — нейтральные коды (`unknown_provider`, `provider_api_key_required`), без upstream-брендов.
- **SQL:** только prepared statements (tagged-template); деньги-операций тут НЕТ (создание агента — не money-path), но запись ключа + апдейт агента атомарны через `sql.begin`.
- **Auth:** оба новых эндпоинта/ветки гейтятся `x-tma-user-id` (nginx инжектит из верифицированного HS256-JWT; spoofable заголовки стрипаются на `/tg`).
- **R1-7 (известный долг, трекается):** ре-валидация `provider_id` SSRF на стадии резолва воркером. Первый срез его НЕ закрывает и НЕ усугубляет; держать в виду при расширении (особенно «Custom URL»).

---

## 7. VERIFY-ON-VPS (нет локального рантайма — проверяем на проде после деплоя)

> Память: `feedback_no_local_runtime` — никакого локального dev/Docker для AIAG. Сборка TMA — ВРУЧНУЮ на VPS (CI не собирает tg-miniapp). Деплой = skill `aiag-deploy`.

**Пре-деплой (локально, статика):**
1. `cd apps/tg-miniapp && bun run typecheck` — зелёный.
2. `bun run lint` — зелёный.

**На VPS (skill `aiag-deploy`):**
3. **Подтвердить миграцию 0026** (§2.1). При отсутствии — применить `psql -f` (§2.2). Read-only проверка не трогает прод-данные.
4. Запулить ветку на VPS, **собрать turbo-libs first** (gateway/db/shared), затем `bun run build` для `tg-miniapp` (root-owned dirs — `infra_tma_deploy_and_prod_db_migrations`).
5. `pm2 restart tma` (НЕ только reload — память про stale-процесс). Проверить `pm2 logs tma --lines 30` — без throw на старте.
6. **Health:** `curl -fsS https://<host>/tg/health` → 200.
7. **Каталог:** в Mini App открыть форму создания агента → блок «🔌 Провайдер из каталога» показывает `<select>` с 8 провайдерами (значит `GET /tg/api/tma/providers` отвечает под auth).
8. **Happy path (брендовый провайдер):** выбрать напр. OpenRouter, ввести валидный свой ключ + модель `openai/gpt-4o-mini` → создать агента. На проде:
   - `sudo -u postgres psql aiag -c "SELECT id, provider_id, model_id, auth_ref IS NOT NULL AS has_ref FROM agents ORDER BY created_at DESC LIMIT 1;"` → `provider_id` проставлен, `has_ref = t`.
   - `sudo -u postgres psql aiag -c "SELECT provider_id, key_hint, length(enc_key) FROM agent_provider_credentials ORDER BY created_at DESC LIMIT 1;"` → `key_hint = ***xxxx`, `enc_key` непустой base64.
9. **Прогон:** запустить агента → в логах воркера/трейсе виден маршрут через выбранного провайдера (ветка A), модель = выбранная. (Воркер код не менялся — это подтверждает сквозную связку write→read.)
10. **SSRF-проба (custom-провайдер):** создать агента с `custom` + `provider_base_url = https://169.254.169.254/v1` → должно отлететь на write-роуте (`private_ip_blocked`) ДО записи. Затем хост, резолвящийся в приватный IP (напр. внутренний) при прогоне → `safeFetch` воркера должен отклонить до коннекта (проверить лог `SsrfError`).
11. **White-label:** в UI и в ошибках нет upstream-брендов нашего шлюза.

**Критерий «готово»:** typecheck/build зелёный → деплой → шаги 7-10 пройдены на проде; денежный путь (`settleRun`) не затронут; SSRF-проба отлетает.

---

## 8. Rollback

- **Код:** ветка не смержена в master (`plan/15.1-r0-billing-identity`). Откат = `git revert` коммитов write-роута + UI + нового эндпоинта, пересборка `tg-miniapp` на VPS, `pm2 restart tma`. Read-сторона воркера не менялась → откат UI/роута безопасен.
- **БД:** миграция 0026 **additive-only** (новые таблицы + nullable-колонки) — откатывать НЕ нужно и НЕ желательно (другие части могут начать на неё опираться; idempotent). Если по какой-то причине надо «отключить» новый путь без отката кода — достаточно `UPDATE providers SET enabled = false;` (каталог опустеет → UI-пикер не покажет провайдеров → пользователи остаются на старых путях). Данные в `agent_provider_credentials` при этом не теряются.
- **Частичный откат UI:** убрать чекбокс «🔌 Провайдер из каталога» (скрыть блок) — оставляет write-роут и эндпоинт нетронутыми, но недостижимыми из UI. Минимальный «kill switch» без передеплоя воркера.
- **Точечный фикс агента:** ошибочно созданный каталожный агент чинится `UPDATE agents SET provider_id=NULL, auth_ref=NULL WHERE id=…` (вернёт его на дефолтный `aiag`-путь) + `DELETE FROM agent_provider_credentials WHERE agent_id=…`.

---

## 9. Adversarial self-review (критический разбор собственного плана)

### 9.1 Трогает ли это живой денежный путь `settleRun`?
**Нет — прямо нет.** Меняем только write-сторону (create-роут TMA), UI и новый read-эндпоинт каталога. `settleRun`, `callWithFallback`, аккумуляторы tool-fee, `isExternal`-семантика веток, `resolveUpstream` — **ноль изменений**. Косвенно: создаётся агент, который при прогоне пойдёт по уже существующей ветке A воркера (`provider_id != null`), которая УЖЕ на проде и УЖЕ протестирована read-стороной. Мы не вводим новую кодовую ветку в денежный путь — мы лишь начинаем заполнять колонки, которые денежный путь уже умеет читать.

### 9.2 Может ли это удвоить списание (double-charge)?
**Нет.** Срез вообще не списывает деньги — это создание агента, не прогон. Списание (`settleRun`) происходит при прогоне и осталось байт-в-байт прежним (guarded `UPDATE … WHERE … RETURNING`, один `sql.begin`). Единственная новая транзакция (§4.3) — это INSERT агента + INSERT credential + UPDATE auth_ref; она НЕ касается `tg_user_balances`. Риск двойной записи credential снят `UNIQUE(agent_id)` на `agent_provider_credentials` (`0026:76`) — второй INSERT на тот же агент отлетит. Дискриминатор взаимоисключающий: `provider_id` ставит ветку A, и мы явно запрещаем одновременный `external_openai` (`connection_conflict`, §4.2).

### 9.3 Может ли утечь бренд провайдера (white-label)?
**Низкий риск, но есть нюанс.** Каталог намеренно содержит ТОЛЬКО пользовательские провайдеры (OpenAI/Anthropic/…/Custom) — это легитимные публичные бренды, которые пользователь сам выбирает (это НЕ наш скрытый upstream). Наш скрытый upstream-бренд (то, что прячет шлюз `:4000` за white-label, напр. OpenRouter/Kie как наш закупочный канал) в каталоге НЕ фигурирует как «наш» — `openrouter` в каталоге = «подключи СВОЙ OpenRouter-ключ», а не «наш OpenRouter». Это семантически разные вещи и не нарушает white-label. Ошибки роута — нейтральные коды без upstream-деталей. **Нюанс к контролю:** не давать тексту UI намёка, что наш дефолтный `aiag`-путь = «OpenRouter внутри». Проверяется шагом 11 верификации.

### 9.4 Влезает ли в 2GB RAM?
**Да, с запасом.** Ноль новых процессов, ноль резидентных подов, ноль новых исходящих к недоверенным хостам сверх того, что воркер УЖЕ делает (ветка A уже ходит к провайдерам). Новый эндпоинт каталога — один SELECT из маленькой таблицы (8 строк). Write-роут — три стейтмента в транзакции на создание агента (редкая операция, не hot-path). Шифрование — та же `node:crypto` машинерия, что уже работает для `external_openai`. Это противоположность MCP-кандидату (новый SDK, новый клиент, prompt-injection поверхность) и аренде (заблокирована D-0/D-1).

### 9.5 Единственный самый большой риск + митигация
**РИСК: миграция 0026 НЕ применена на проде (ручные/нетрекаемые миграции — `packages/database/CLAUDE.md`).** Если её нет, то: эндпоинт каталога вернёт пустой список или 500 (нет таблицы `providers`), а write-роут упадёт на INSERT в несуществующую `agent_provider_credentials` / на отсутствующие колонки `agents.provider_id` — пользователь не сможет создать агента каталожным путём, а в худшем случае получит 500 на форме создания.
**МИТИГАЦИЯ:** §2.1 — **первый шаг деплоя = read-only проверка `\dt providers` + `\d agents`**, и только при подтверждении применять идемпотентный `psql -f 0026` (§2.2). Это не предположение, а явный gate чек-листа (шаг 3 §7) ДО сборки/рестарта TMA. Плюс write-роут уже мягко падает на `unknown_provider`, если каталог пуст (provider lookup вернёт пусто) → форма покажет ошибку, а не 500, для брендовых провайдеров; custom-путь тоже сначала валидирует провайдера. Итог: даже при незамеченном пропуске миграции деградация управляемая, а чек-лист её ловит на первом шаге.

### 9.6 Прочие замеченные риски (вторичные)
- **Латентный баг `DEFAULT_MODEL`:** если пользователь оставит поле модели пустым и `cred.model_id` тоже пуст, воркер падёт на `DEFAULT_MODEL`. Дефолт в `agent-runner.ts:37` уже исправлен на `openai/gpt-4o-mini`, но для брендового провайдера (напр. Anthropic) этот slug может не существовать у НЕГО → 400. **Митигация:** в UI поле модели для каталожного пути лучше сделать рекомендуемым (не пустым) — на первом срезе оставляем опциональным, но в верификации (шаг 8) задаём модель явно. Документировать как known-edge.
- **Currency:** бюджет агента всё ещё в ₽ (`budget_rub_monthly`) — миграция в USD-кредит (D-1) ожидается; provider-picker её НЕ требует и НЕ блокирует.
- **Founder-развилка (§4.4):** «каталожный BYOK = 0 комиссии?» — НЕ предрешаем; UI на срезе не обещает «бесплатно» для каталожного пути. Это снимает риск ложного обещания до решения основателя.

---

## 10. Сводка зависимостей

- **Блокеров нет** для первого среза (в отличие от аренды — D-0/D-1). Всё, что нужно: подтвердить 0026 на проде (read-only gate), добавить 1 эндпоинт + расширить 1 роут + 1 UI-блок.
- **Следующий шаг после среза** (отдельно): редактирование подключения у существующего агента, кнопка «проверить соединение» для каталожного пути, founder-решение по `isExternal` каталожного BYOK, затем выпил legacy `external_openai`-блока. Дальше по канон-последовательности — MCP read-only v1 (переиспользует то же шифрование + safeFetch).
