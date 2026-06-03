# feat-1 — Карта рантайма agent-worker и роутинга провайдеров

> Read-only исследование. Цель: описать сегодняшний рантайм агентов (стейтлес-цикл BullMQ→gateway)
> в продуктовых терминах И с точной привязкой `file:line`. Источники:
> - `apps/agent-worker/src/agent-runner.ts`
> - `apps/agent-worker/src/tools.ts`
> - `apps/agent-worker/src/safe-fetch.ts`
> - `apps/agent-worker/src/db.ts`
>
> Контекст реальности (из `/CLAUDE.md`): «Hermes»-рантайма НЕТ. Сегодня это **стейтлес-цикл**
> `BullMQ → resolveUpstream → :4000 gateway (или внешний провайдер) → upstream`, без per-user
> процесса, без изоляции, без памяти между прогонами кроме инструмента `memory`.

---

## 0. Карта рантайма в одном абзаце (продуктовый язык)

Юзер шлёт запрос → создаётся `agent_run` → BullMQ-воркер вызывает `runAgent(runId)`
(`agent-runner.ts:350`). Воркер: грузит run+agent, проверяет месячный/дневной бюджет,
**решает куда направить прогон** (`resolveUpstream`, `agent-runner.ts:57`), проверяет
баланс (если прогон биллится), затем крутит **цикл ≤12 итераций** (`MAX_ITERATIONS=12`,
`agent-runner.ts:38`, `:430`): каждый виток зовёт модель (`callModel`→`callWithFallback`),
если модель вернула tool-calls — исполняет инструменты (`executeTool`, `tools.ts:329`) и
докладывает результаты в диалог, пока модель не вернёт финальный ответ. На финале —
атомарный `settleRun` (списание кредитов) + уведомление в Telegram. Память между прогонами
есть только через инструмент `memory` (Postgres KV, per-agent).

---

## 1. Как сегодня определяются и исполняются инструменты?

### 1.1 Форма `ToolDef` (OpenAI function-calling shape)
`tools.ts:12-19`:
```ts
export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
```
Это ровно OpenAI-совместимая function-схема. Массив `TOOL_DEFS` (`tools.ts:21-86`) — это
**статический, захардкоженный** список из 4 определений. Он попадает в тело запроса к модели
через `buildBody` (`agent-runner.ts:152-167`): если `tools.length > 0`, ставится
`body.tools = tools` и `body.tool_choice = 'auto'` (`agent-runner.ts:162-165`).

### 1.2 Какие инструменты «реальные»? (4 реальных + 1 заглушка + graceful-degrade)
Определены в `TOOL_DEFS` и исполняются в диспетчере `executeTool` (`tools.ts:343-367`):

| tool | определение | реализация | cost_rub | реальность |
|---|---|---|---|---|
| `web_search` | `tools.ts:24-34` | `webSearch` — скрейп `html.duckduckgo.com` regex'ом (`tools.ts:112-138`) | **0** (`tools.ts:345`) | реальный, без API-ключа |
| `calc` | `tools.ts:37-47` | `calc` — `new Function()` по whitelisted charset `^[\d+\-*/().\s]+$` (`tools.ts:161-179`) | **0** (`tools.ts:347`) | реальный |
| `image_gen` | `tools.ts:49-66` | `imageGen` → Kie.ai `createTask`→poll (`tools.ts:202-275`) | **6.5₽** если есть `KIE_API_KEY`, иначе placehold-заглушка с **0** (`tools.ts:261-275`, `:353`) | реальный (или graceful placeholder) |
| `memory` | `tools.ts:68-85` | `memoryTool` — Postgres KV per-agent set/get/list (`tools.ts:288-315`) | **0** (`tools.ts:362`) | реальный |

Плюс:
- `code_interpreter` — **намеренно НЕ реализован** (`UNIMPLEMENTED_TOOLS`, `tools.ts:92`).
  В `executeTool` возвращает `{error: "...not available..."}`, `cost_rub:0` (`tools.ts:336-341`).
  Причина в комментарии: «arbitrary code execution is a security risk we don't take on».
- Любой неизвестный tool → graceful degrade `{error: "...not available"}` (`default`, `tools.ts:364-366`),
  а не throw. Весь `switch` обёрнут в try/catch → ошибка инструмента не валит прогон (`tools.ts:368-370`).

**Итого: 4 реальных инструмента** (`web_search`, `calc`, `image_gen`, `memory`).

### 1.3 Фильтрация инструментов по агенту (whitelist)
`pickToolDefs(allowed)` (`tools.ts:98-102`): берёт `agent.tools[]` (whitelist) и фильтрует
`TOOL_DEFS`. **Пустой/null whitelist ⇒ `[]`** — инструменты выключены, модель отвечает «из
своих знаний» (это же отражено в системном промпте, `buildSystem`, `agent-runner.ts:327-336`).
Вызов: `agent-runner.ts:411` `const tools = pickToolDefs(agent.tools)`.

### 1.4 Как cost обрабатывается (форма + поток денег tool-fee)
- `executeTool` возвращает `ToolExecResult { result: unknown; cost_rub: number }` (`tools.ts:319-322`).
- В цикле: после каждого tool-call воркер делает
  `if (exec.cost_rub > 0) toolFeesRub += exec.cost_rub` (`agent-runner.ts:560-565`).
  **Важно:** комментарий `:561-563` подчёркивает — копить надо в отдельный `toolFeesRub`,
  НЕ в `totalCostRub`, потому что следующая итерация пересчитывает
  `totalCostRub = (basis + toolFeesRub)` (`agent-runner.ts:464`, `:473`) и затёрла бы прямую добавку.
- Tool-fee едет «поверх» биллинговой базы (gateway-authoritative ИЛИ локальная оценка),
  и попадает внутрь итогового `finalBillableCostRub` (флор `MIN_RUN_COST`, `agent-runner.ts:322-325`, `:515`).
- Результат инструмента возвращается модели как `role:'tool'` сообщение, **обрезанное до 8000 символов**:
  `content: JSON.stringify(exec.result).slice(0, 8000)` (`agent-runner.ts:566-570`).

### 1.5 Цикл инструментов (tool loop) — пошагово
`runAgent`, `agent-runner.ts:430-572`:
1. `for i in 0..MAX_ITERATIONS(12)` (`:430`).
2. `call = await callModel(upstream, messages, tools)` (`:433`); ошибка → `markFailed('upstream_error')` (`:434-438`).
3. Аккумуляция токенов (`:442-443`) и биллинга gateway/оценки (`:448-474`).
4. Mid-run cutoff бюджета (месяц+день) (`:477-486`).
5. Берём `choice = resp.choices[0]`; пусто → `empty_response` (`:488-493`).
6. **Если нет tool_calls** → это финал: лог D-0 маржи (`:503-510`), `finalBillableCostRub` (`:515`),
   атомарный `settleRun` (`:519-529`), уведомление, `return` (`:541-542`).
7. **Если есть tool_calls** → пишем assistant-сообщение с tool_calls в диалог (`:546-550`),
   затем для каждого: парсим `function.arguments` JSON (битый JSON → `{}`, `:553-558`),
   `executeTool(name, parsed, {agentId})` (`:559`), копим tool-fee (`:560-565`),
   докладываем `role:'tool'` (`:566-570`). Возврат к шагу 1.
8. Если 12 итераций не сошлись → `markFailed('max_iterations_exceeded')` (`:574-575`).

`ToolContext` сегодня несёт только `{ agentId }` (`tools.ts:325-327`) — это единственный
контекст, доступный инструменту (нужно для per-agent памяти).

---

## 2. Как `resolveUpstream` решает куда идёт прогон?

`resolveUpstream(agent): Promise<Upstream>` — `agent-runner.ts:57-110`. Возвращает
`Upstream { url, apiKey, model, isExternal }` (`agent-runner.ts:50-55`). Решение по
приоритету «самое специфичное первым», три ветки:

### Ветка A — provider-picker (новый каталог, миграция 0026) — `agent-runner.ts:61-73`
Триггер-поле: **`agent.provider_id != null`** (`:61`).
- Грузит credential по `agent.auth_ref` → `loadProviderCredential` (`agent-runner.ts:62`,
  реализация `db.ts:98-130`): JOIN `agent_provider_credentials c` × `providers p`.
- База URL выбирается: `agent.base_url_override ?? cred.base_url ?? cred.api_base`, с trailing-slash
  trim (`:64`). Нет базы → throw `provider_base_url_missing` (`:65`).
- URL нормализуется: если кончается на `/chat/completions` — как есть, иначе `+'/chat/completions'` (`:66`).
- `apiKey = decryptSecret(cred.enc_key)` (`:69`); `model = agent.model_id ?? cred.model_id ?? DEFAULT_MODEL` (`:70`).
- **`isExternal: false`** (`:71`) — провайдер-пикер БИЛЛИТСЯ через нас (списываем баланс).
  Поля-драйверы: `provider_id`, `auth_ref`, `base_url_override`, `model_id` (тип в `db.ts:11-33`).
  Credential-поля: `base_url`, `api_base`, `enc_key`, `model_id`, `requires_base_url` (`db.ts:79-86`).

### Ветка B — внешний OpenAI (legacy BYO endpoint) — `agent-runner.ts:75-88`
Триггер-поле: **`agent.connection_type === 'external_openai'`** (`:75`).
- Требует `external_base_url` и `external_api_key_encrypted` (`:76-77`).
- База = `external_base_url` (trailing-slash trim), URL нормализуется так же (`:78-81`).
- `apiKey = decryptSecret(external_api_key_encrypted)` (`:82`);
  `model = external_model_slug || model_slug || DEFAULT_MODEL` (`:83-86`).
- **`isExternal: true`** (`:87`) — это **BYOK/own-provider ⇒ комиссия 0** (правило коммиссии),
  юзер платит своему провайдеру; см. §1.4 и `finalBillableCostRub` (`:322-324`).

### Ветка C — AIAG-путь (дефолт `connection_type === 'aiag'`) — `agent-runner.ts:90-109`
Если ни provider_id, ни external_openai. `model = agent.model_slug || DEFAULT_MODEL` (`:98`).
- Если есть `AIAG_GATEWAY_KEY` → `url = AIAG_GATEWAY_URL (http://127.0.0.1:4000/v1/chat/completions)`,
  `apiKey = gwKey`, **`isExternal: false`** (`:99-101`). Это канонический путь: маркап + white-label.
- **Graceful fallback** (deploy-safety): если ключа нет — direct OpenRouter с `OPENROUTER_API_KEY`,
  `isExternal: false`, громкий `console.warn` (`:103-109`). Нет и OpenRouter-ключа → throw (`:104`).

### Сводка полей-драйверов (что решает маршрут)
| поле агента | эффект |
|---|---|
| `provider_id` (not null) | → Ветка A (provider-picker, billable) |
| `auth_ref` | → какой credential грузить в Ветке A |
| `base_url_override` / `model_id` | → переопределяют base/model в Ветке A |
| `connection_type='external_openai'` | → Ветка B (BYOK, **isExternal=true, 0 комиссии**) |
| `external_base_url` / `external_api_key_encrypted` / `external_model_slug` | → конфиг Ветки B |
| `connection_type='aiag'` (+ `model_slug`) | → Ветка C (gateway / OR-fallback, billable) |
| env `AIAG_GATEWAY_KEY` / `OPENROUTER_API_KEY` | → gateway vs degraded fallback в Ветке C |

### Биллинг и fallback на уровне вызова (`callWithFallback`, `agent-runner.ts:254-294`)
- `isGateway = upstream.url === AIAG_GATEWAY_URL` (`:259`).
- На gateway-пути читает authoritative ₽-заголовки `x-aiag-charged-rub` /
  `x-aiag-upstream-cost-rub` (`HDR_*`, `:44-45`, парсинг `:264-265`, `parseRubHeader` `:232-237`).
- Деградированный fallback: **только** для gateway-пути и **только** при model-not-found
  (`isModelNotFound`: 404 ИЛИ 400 «unknown model» ИЛИ regex, `:206-210`, `:279`) →
  переотправка тем же телом в OpenRouter (`:280-290`); тогда `billedByGateway=false` ⇒
  caller оценивает по `estimateCostRub` (`:284-286`, `:304-308`), но **никогда не 0** для billable.
- ⚠️ **Латентный баг (уже зафиксирован в комментариях):** старый `DEFAULT_MODEL`
  `nousresearch/hermes-4-405b` отсутствовал в реестре gateway → 400 «Unknown model».
  В этом файле дефолт уже исправлен на `openai/gpt-4o-mini` (`agent-runner.ts:37`,
  комментарий `:34-37`), но `apps/agent-worker/CLAUDE.md` всё ещё называет дефолтом hermes
  — проверять при правках.

---

## 3. Куда именно подключается НОВЫЙ источник инструментов (MCP) или НОВЫЙ провайдер?

### 3.1 Новый провайдер
- **Минимальный путь (без кода):** новый провайдер уже поддержан Веткой A —
  достаточно строки в таблице `providers` (`api_base`, `requires_base_url`) + credential в
  `agent_provider_credentials` + проставить `agent.provider_id`/`auth_ref`. `resolveUpstream`
  Ветка A (`agent-runner.ts:61-73`) и `loadProviderCredential` (`db.ts:98-130`) уже всё разрулят,
  если провайдер **OpenAI-совместимый** (`/chat/completions`).
- **Если провайдер НЕ OpenAI-совместимый** (другой формат тела/ответа): нужна новая ветка в
  `resolveUpstream` + адаптер тела в `buildBody` (`agent-runner.ts:152-167`) и парсинга в
  `callWithFallback`/`ModelResponse` (`:136-150`, `:266`). Сейчас весь воркер жёстко
  предполагает OpenAI chat-completions shape.
- **Точка плагина для биллинга нового провайдера:** флаг `isExternal` в `Upstream`
  (`agent-runner.ts:54`) решает, списывать ли (билл) или 0. Любой новый billable-провайдер
  ставит `isExternal:false`; BYO — `true`.

### 3.2 Новый источник инструментов (например, MCP-сервер, подключённый юзером)
Сегодня инструментов-источник ровно один — статический `TOOL_DEFS` (`tools.ts:21`). Чтобы
подключить MCP/динамический источник, точки врезки:

1. **Объявление (что модель видит):** `pickToolDefs` (`tools.ts:98-102`) должен помимо статики
   подмешивать tool-defs, полученные с MCP-сервера агента (MCP `tools/list` → маппинг в `ToolDef`).
   Сейчас сигнатура `pickToolDefs(allowed: string[])` — её надо расширить контекстом агента
   (откуда тянуть MCP-конфиг), и вызов в `agent-runner.ts:411` соответственно.
2. **Исполнение:** `executeTool` (`tools.ts:329-367`) — добавить ветку, которая по неизвестному
   имени НЕ деградирует в `{error}` (`default`, `:364-366`), а проксирует MCP `tools/call`.
   Нужно прокинуть MCP-эндпоинт/креды через `ToolContext` (`tools.ts:325-327`), который сегодня
   несёт только `{ agentId }` — это **самая узкая точка расширения**.
3. **Сеть:** любой исходящий вызов к MCP-серверу юзера ОБЯЗАН идти через `safeFetch`
   (`safe-fetch.ts:225`), а НЕ через голый `fetch` — текущие инструменты (`webSearch` `tools.ts:114`,
   Kie `tools.ts:205`/`:231`) используют голый `fetch`, что для **доверенных хардкод-хостов** ок,
   но для **user-supplied MCP URL это обязателен safeFetch** (см. §4).
4. **Стоимость:** MCP-tool возвращает `cost_rub` через ту же `ToolExecResult` (`tools.ts:319-322`);
   поток tool-fee (§1.4) уже готов это принять без изменений.
5. **R&D-статус:** по `/CLAUDE.md` MCP-серверы/skills-hub — это **R&D, не построено**; врезка
   выше описана как «куда бы это легло», а не как существующий код.

---

## 4. SSRF-guard (`safeFetch`) и валидация user-supplied MCP/provider URL

Файл: `apps/agent-worker/src/safe-fetch.ts` (локальная копия `packages/shared/src/safe-fetch.ts`,
синхронизировать вручную — примечание `safe-fetch.ts:1-19`). Экспорт `safeFetch` (`:225-269`).

### 4.1 Модель угрозы (комментарий `safe-fetch.ts:9-19`)
`external_openai`/provider агенты дают юзеру задать произвольный base_url → наивный fetch
доверяет DNS+редиректам → атакующий целит воркер в metadata (`169.254.169.254`), localhost,
БД/Redis, RFC1918 — через DNS-rebinding, integer-IP-литерал, или 302-редирект public→internal.

### 4.2 Защиты (что проверяется)
- **HTTPS-only** для не-allowlisted хостов (`vetUrl`, `safe-fetch.ts:160-161`).
- **Reject integer-encoded IP-литералов** (octal/decimal/hex) (`rejectNumericLiteral`, `:129-137`, вызов `:164`).
- **DNS-resolve ВСЕХ A/AAAA**, reject если ЛЮБОЙ в блок-сете (`:173-190`); пин сокета к
  провалидированному IP через per-request undici `Agent` (anti-rebind, Node-only, `buildPinnedDispatcher` `:195-217`, врезка диспетчера `:239-249`).
- **Re-validate каждый redirect-hop** (`redirect:'manual'`, цикл `:236-266`, cap `MAX_REDIRECTS=5` `:28`).
- **Блок-диапазоны IPv4** (`blockedIPv4`, `:64-80`): `10/8`, `172.16/12`, `192.168/16`, `127/8`,
  `169.254/16` (incl. metadata), `100.64/10` CGNAT, `0/8`.
- **Блок-диапазоны IPv6** (`blockedIPv6`, `:87-116`): `::1`, `::`, `fc00::/7` ULA, `fe80::/10`
  link-local, `::ffff:0:0/96` IPv4-mapped (разворачивается и пере-проверяется как IPv4).
- **Allowlist** точного `host` или `host:port` (`:155-157`): обходит И HTTPS-, И IP-проверку.
  Сейчас allowlist = `['127.0.0.1:4000', 'openrouter.ai']` (`agent-runner.ts:33`,
  `SAFE_FETCH_ALLOWLIST`). `127.0.0.1:4000` — http внутренний gateway, поэтому он обязан быть в
  allowlist (`agent-runner.ts:29-33`).

### 4.3 Как валидировался бы user-supplied MCP/provider URL
- **provider/external upstream УЖЕ покрыты:** `postChat` гонит все upstream-вызовы через
  `safeFetch` с `allowlist: SAFE_FETCH_ALLOWLIST` (`agent-runner.ts:193-198`). Значит
  user-supplied `external_base_url`/`base_url_override` (Ветки A/B) проходят полную IP-валидацию,
  т.к. их хостов нет в allowlist (комментарий `:187-192`).
- **Новый MCP URL юзера** должен идти **тем же путём**: `safeFetch(mcpUrl, {allowlist: SAFE_FETCH_ALLOWLIST})`
  — НИКОГДА не добавлять user-controlled хост в allowlist (это бы выключило проверку). MCP-вызовы
  тогда автоматически получат HTTPS-only + DNS+IP-reject + pin + redirect-revalidation.
- ⚠️ **Известный gap (трекается, не зафикшен):** `provider_id` SSRF re-validation (R1-7, см.
  `/SECURITY.md`) — повторная валидация provider_id на стадии резолва; и инструментальные
  голые `fetch` (`webSearch`/Kie) НЕ через safeFetch (ок для хардкод-хостов, недопустимо для
  любых user-supplied URL).

---

## 5. Точечные ссылки (TL;DR file:line)

- Рантайм-цикл: `agent-runner.ts:350` (`runAgent`), `:430-572` (tool loop), `MAX_ITERATIONS=12` `:38`.
- Роутинг: `resolveUpstream` `:57-110` (A `:61`, B `:75`, C `:90`); `Upstream`/`isExternal` `:50-55`.
- Вызов+биллинг+fallback: `callWithFallback` `:254-294`; `isModelNotFound` `:206-210`; ₽-заголовки `:44-45`,`:232-237`.
- Деньги: `estimateCostRub` `:304-308`; `finalBillableCostRub` (флор) `:322-325`; tool-fee accrual `:560-565`; settle `:519-529`.
- Инструменты: `ToolDef` `tools.ts:12-19`; `TOOL_DEFS` `:21-86`; `pickToolDefs` `:98-102`;
  `executeTool` `:329-367`; `UNIMPLEMENTED_TOOLS` `:92`; `ToolExecResult`/`ToolContext` `:319-327`.
- SSRF: `safeFetch` `safe-fetch.ts:225-269`; `vetUrl` `:139-193`; IPv4/IPv6 классификаторы `:64-116`;
  allowlist `agent-runner.ts:33` + `safe-fetch.ts:155-157`; врезка в upstream `agent-runner.ts:193-198`.
- БД/типы: `AgentRow` `db.ts:11-33`; `loadAgent` `:56-75`; `ProviderCredential` `:79-86`;
  `loadProviderCredential` `:98-130`.
