# Hermes Bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Заменить временный stateless-loop реальным мостом: Agents Market запускает агентов на Hermes основателя (сервер №2), деньги считаются у нас; опубликованный профиль можно нанять и он исполняется в Hermes.

**Architecture:** `agent-worker` (сервер №1) обращается к Hermes REST `:8642` (сервер №2) через **обратный SSH-туннель** (Hermes-бокс держит `localhost:8642` сервера №1 = свой Hermes). Hermes OpenAI-совместим → профиль адресуется как `model`, изоляция нанимателя = заголовок `X-Hermes-Session-Key` (выводится СЕРВЕРНО из runId). Наша БД = source-of-record по деньгам и namespace памяти. Loop удаляется: прогон без Hermes-маршрута падает с честным статусом, НЕ через OpenRouter.

**Tech Stack:** agent-worker (BullMQ/Node/TS), Hermes REST `:8642` (Bearer `API_SERVER_KEY` + `X-Hermes-Session-Key`), Postgres, autossh+systemd (туннель). Hermes-бокс уже на свежем main (post-v0.17), REST проверен 2026-06-24.

## Global Constraints (verbatim)
- **Money-path правки ТОЛЬКО additive.** `settleRun` дебетит нанимателя; формулу/маркап не менять. **Managed-Hermes (наш бокс) = AIAG-путь → debit+markup (isExternal=false). Connect-your-own-Hermes (бокс/ключи юзера) = ZERO (isExternal=true)**, как BYOK (`if (isExternal) return` в settleRun остаётся).
- Наша БД = source-of-record памяти (Hermes-память небезопасна из коробки, баг #4726). Hermes-память = кэш.
- Next пинить **14.2.33** (CVE) — не трогать.
- **SSH к боксу `176.124.211.11` (hermes@, key `~/.ssh/timeweb_vps`): ОДИН батч-heredoc-коннект, НЕ долбить (fail2ban).** Диск бокса 92% — ничего крупного не лить. ControlMaster на Windows не работает.
- Hermes REST auth = **статический `Bearer API_SERVER_KEY`**; изоляция = **`X-Hermes-Session-Key`** (сервер выводит из runId, НЕ из тела запроса).
- typecheck зелёный перед коммитом. Прод-миграции применять ВРУЧНУЮ ДО деплоя кода (`sudo -u postgres psql aiag`). НЕ запускать локальный рантайм — проверка на VPS после деплоя.
- Сервер №1 = `5.129.200.99` (aiag: tma+agent-worker под root-pm2). Сервер №2 = `176.124.211.11` (Hermes, systemd-user `hermes-gateway`).

---

## File Structure
- **Create** `apps/agent-worker/src/hermes-client.ts` — тонкий REST-клиент Hermes: `hermesChat()` (OpenAI-совм. `/v1/chat/completions` с профилем-как-model + session-key), `hermesEnabled()`, типы. Одна ответственность: говорить с `:8642`.
- **Modify** `apps/agent-worker/src/agent-runner.ts` — `resolveUpstream()` (новая ветка Hermes), `postChat()` (доп. заголовки), удалить OpenRouter-loop как движок по умолчанию (`callWithFallback` fallback → убрать; нет Hermes-маршрута → честный фейл).
- **Create** `packages/database/migrations/0045_agent_hermes_profile.sql` — `agents.hermes_profile TEXT` + расширить `connection_type` значениями `hermes_managed` / `hermes_own`.
- **Modify** `apps/tg-miniapp/app/agents/new/page.tsx` + `app/api/tma/agents/route.ts` — поле «Hermes-профиль» (managed) / «свой Hermes URL» (own) при создании.
- **Ops (runbook, не код)** туннель: systemd-user unit на боксе №2; env в `/srv/aiag/shared/.env` на сервере №1.

---

## ФАЗА 0 — Связность (ops-runbook; без этого мост не поедет)
*Обратный SSH-туннель: бокс №2 → сервер №1. Сервер №1 ходит на `http://127.0.0.1:8642` = Hermes бокса №2. Туннель инициирует бокс №2 (исходящий) → не упирается в fail2ban сервера №1 и стабильнее, чем дёргать бокс №2.*

### Task 0.1 — Ключ доступа бокс№2 → сервер№1
**Где:** ОДИН батч-коннект к боксу №2 (через прокси, как в memory `project_hermes_runtime_setup`).
- [ ] На боксе №2 сгенерить ключ (если нет): `ssh-keygen -t ed25519 -f ~/.ssh/to_aiag -N ""`; вывести `cat ~/.ssh/to_aiag.pub`.
- [ ] На сервере №1 добавить этот pub-ключ в `/root/.ssh/authorized_keys` с ограничением (command-restrict не нужен, но `permitlisten` фикс порт): строка вида `restrict,permitlisten="127.0.0.1:8642" ssh-ed25519 AAAA... hermes-tunnel`.
- [ ] Проверить вручную с бокса №2: `ssh -i ~/.ssh/to_aiag -N -R 127.0.0.1:8642:127.0.0.1:8642 root@5.129.200.99 &` затем на сервере №1 `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8642/health` → ожидать `200` (или `401` на `/v1/models` без ключа = туннель жив). Убить ручной туннель.

### Task 0.2 — Постоянный туннель (systemd-user на боксе №2)
**Где:** бокс №2, тот же батч-коннект.
- [ ] Создать `~/.config/systemd/user/aiag-tunnel.service`:
```
[Unit]
Description=Reverse SSH tunnel: expose local Hermes :8642 to aiag server
After=network-online.target
[Service]
ExecStart=/usr/bin/ssh -NT -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new -i %h/.ssh/to_aiag -R 127.0.0.1:8642:127.0.0.1:8642 root@5.129.200.99
Restart=always
RestartSec=10
[Install]
WantedBy=default.target
```
- [ ] `systemctl --user daemon-reload && systemctl --user enable --now aiag-tunnel && loginctl enable-linger hermes` (чтобы жил без активной сессии). Проверить `systemctl --user is-active aiag-tunnel` = active.
- [ ] Verify с сервера №1: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8642/health` = 200.

### Task 0.3 — Env на сервере №1
**Где:** сервер №1 `/srv/aiag/shared/.env` (значение `API_SERVER_KEY` взять с бокса №2 из `~/.hermes/.env` — НЕ печатать в логи).
- [ ] Добавить: `HERMES_GATEWAY_URL=http://127.0.0.1:8642` и `HERMES_API_KEY=<API_SERVER_KEY бокса №2>`.
- [ ] (env подхватится при `pm2 restart agent-worker --update-env` под root на шаге деплоя Фазы 1.)

---

## ФАЗА 1 — Мост (single-profile MVP) + удаление loop

### Task 1.1 — Hermes REST-клиент
**Files:** Create `apps/agent-worker/src/hermes-client.ts`; Test `apps/agent-worker/src/__tests__/hermes-client.test.ts`.

**Interfaces — Produces:**
- `hermesEnabled(): boolean` — true если заданы `HERMES_GATEWAY_URL` и `HERMES_API_KEY`.
- `hermesChat(args: { profile: string; messages: Array<{role:string;content:string}>; sessionKey: string; signal?: AbortSignal }): Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }>` — зовёт `POST {HERMES_GATEWAY_URL}/v1/chat/completions` с body `{ model: profile, messages, stream:false }`, заголовки `Authorization: Bearer ${HERMES_API_KEY}`, `X-Hermes-Session-Key: ${sessionKey}`, `Content-Type: application/json`. Бросает `Error('hermes_unreachable')` на сетевой сбой/не-2xx.

- [ ] **Step 1: Тест (мок fetch)** — `apps/agent-worker/src/__tests__/hermes-client.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
beforeEach(() => { process.env.HERMES_GATEWAY_URL='http://127.0.0.1:8642'; process.env.HERMES_API_KEY='k'; vi.restoreAllMocks(); });
import { hermesChat, hermesEnabled } from '../hermes-client';
it('hermesEnabled reflects env', () => { expect(hermesEnabled()).toBe(true); });
it('hermesChat posts profile-as-model + session-key, parses usage', async () => {
  const spy = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue(new Response(
    JSON.stringify({ choices:[{message:{content:'hi'}}], usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7} }),
    { status:200, headers:{'content-type':'application/json'} }));
  const r = await hermesChat({ profile:'backend-eng', messages:[{role:'user',content:'q'}], sessionKey:'run_1' });
  expect(r.content).toBe('hi'); expect(r.usage.total_tokens).toBe(7);
  const [url, init] = spy.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('http://127.0.0.1:8642/v1/chat/completions');
  expect((init.headers as Record<string,string>)['X-Hermes-Session-Key']).toBe('run_1');
  expect(JSON.parse(init.body as string).model).toBe('backend-eng');
});
it('hermesChat throws hermes_unreachable on non-2xx', async () => {
  vi.spyOn(globalThis,'fetch' as any).mockResolvedValue(new Response('e',{status:502}));
  await expect(hermesChat({ profile:'x', messages:[], sessionKey:'r' })).rejects.toThrow('hermes_unreachable');
});
```
- [ ] **Step 2: Запустить — упадёт** (`hermes-client` не существует). Run: `cd apps/agent-worker && bunx vitest run src/__tests__/hermes-client.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Реализация** `apps/agent-worker/src/hermes-client.ts`:
```ts
// Hermes REST client (server #2 via reverse tunnel). OpenAI-compatible: profile = model.
// Auth = static Bearer API_SERVER_KEY; per-tenant isolation = X-Hermes-Session-Key
// (caller derives it from runId, never from the request body).
export function hermesEnabled(): boolean {
  return Boolean(process.env.HERMES_GATEWAY_URL && process.env.HERMES_API_KEY);
}
interface ChatArgs { profile: string; messages: Array<{ role: string; content: string }>; sessionKey: string; signal?: AbortSignal }
export async function hermesChat(args: ChatArgs): Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const base = (process.env.HERMES_GATEWAY_URL ?? '').replace(/\/$/, '');
  const key = process.env.HERMES_API_KEY ?? '';
  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Hermes-Session-Key': args.sessionKey },
      body: JSON.stringify({ model: args.profile, messages: args.messages, stream: false }),
      signal: args.signal,
    });
  } catch { throw new Error('hermes_unreachable'); }
  if (!res.ok) throw new Error('hermes_unreachable');
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
  return {
    content: j.choices?.[0]?.message?.content ?? '',
    usage: { prompt_tokens: j.usage?.prompt_tokens ?? 0, completion_tokens: j.usage?.completion_tokens ?? 0, total_tokens: j.usage?.total_tokens ?? 0 },
  };
}
```
- [ ] **Step 4: Тест зелёный.** Run: `bunx vitest run src/__tests__/hermes-client.test.ts`. Expected: PASS (3).
- [ ] **Step 5: Commit** `git add apps/agent-worker/src/hermes-client.ts apps/agent-worker/src/__tests__/hermes-client.test.ts && git commit -m "feat(worker): Hermes REST client (profile-as-model + session-key)"`.

### Task 1.2 — Миграция: маршрут агента на Hermes
**Files:** Create `packages/database/migrations/0045_agent_hermes_profile.sql`.
- [ ] **Step 1:** написать (additive, идемпотентно):
```sql
-- 0045_agent_hermes_profile.sql — маршрут запуска агента на Hermes.
-- connection_type расширяется: 'aiag'|'external_openai' (старое) + 'hermes_managed'
-- (наш бокс, профиль в hermes_profile, AIAG-биллинг) + 'hermes_own' (свой Hermes URL,
-- ZERO-комиссия как BYOK). hermes_profile = имя профиля (=model в REST). ADDITIVE.
BEGIN;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS hermes_profile TEXT NULL;
COMMIT;
```
- [ ] **Step 2: Commit** `git add packages/database/migrations/0045_agent_hermes_profile.sql && git commit -m "feat(db): 0045 agents.hermes_profile (Hermes route)"`.

### Task 1.3 — `postChat` поддерживает доп-заголовки
**Files:** Modify `apps/agent-worker/src/agent-runner.ts` (`postChat` ~243-330).
- [ ] **Step 1:** добавить опц. параметр `extraHeaders?: Record<string,string>` в сигнатуру `postChat` и влить его в объект заголовков запроса (после существующих, до fetch). Не менять остальную логику/allowlist.
- [ ] **Step 2:** добавить `127.0.0.1:8642` в `SAFE_FETCH_ALLOWLIST` (строка ~40) — туннельный Hermes-эндпоинт.
- [ ] **Step 3: typecheck** `cd apps/agent-worker && bunx tsc --noEmit` зелёный. **Commit** `git commit -am "feat(worker): postChat extraHeaders + allowlist 8642"`.

### Task 1.4 — Ветка Hermes в `resolveUpstream` + честный фейл вместо loop
**Files:** Modify `apps/agent-worker/src/agent-runner.ts` (`resolveUpstream` ~127-175, `callWithFallback` ~333-376, `runAgent` ~532-808).

**Interfaces — Consumes:** `hermesChat`, `hermesEnabled` (Task 1.1); `agents.hermes_profile`, `agents.connection_type` (Task 1.2).

- [ ] **Step 1:** В `resolveUpstream`: ДО существующей gateway/OpenRouter логики добавить ветку — если `agent.connection_type === 'hermes_managed'` и `agent.hermes_profile`:
```ts
if (agent.connection_type === 'hermes_managed' && agent.hermes_profile) {
  if (!hermesEnabled()) throw new Error('hermes_disabled');
  return {
    url: `${(process.env.HERMES_GATEWAY_URL ?? '').replace(/\/$/, '')}/v1/chat/completions`,
    apiKey: process.env.HERMES_API_KEY ?? '',
    model: agent.hermes_profile,
    isExternal: false,                 // наш движок → debit+markup
    extraHeaders: { 'X-Hermes-Session-Key': /* runId-scoped, см. Step 2 */ '' },
  };
}
```
(Если `Upstream` тип не имеет `extraHeaders` — добавить поле `extraHeaders?: Record<string,string>` в его определение.)
- [ ] **Step 2:** `X-Hermes-Session-Key` = серверный scope. В `runAgent`, где известен `runId` + scope найма (`resolveRunScope`), сформировать `sessionKey = `${agentId}:${hirerScope ?? 'owner'}`` и прокинуть в `postChat(..., upstream.extraHeaders)`. НЕ брать из тела запроса.
- [ ] **Step 3 — УДАЛИТЬ loop как движок по умолчанию:** в `callWithFallback` убрать OpenRouter-fallback ветку (строки вокруг 364 `postChat(OPENROUTER_URL, orKey, ...)`); оставить ТОЛЬКО маршрут из `resolveUpstream`. Для агентов БЕЗ Hermes-маршрута и не-external: `runAgent` помечает прогон `failed` с сообщением-статусом `«Движок Hermes подключается»` (честно), НЕ зовёт OpenRouter. (Gateway :4000 как прямой движок агента тоже больше не путь по умолчанию — модель зовёт Hermes-профиль через свой base_url=:4000; наш agent-runner напрямую модель-как-агента не крутит.)
- [ ] **Step 4:** Сохранить `settleRun` как есть — он считает по `usage`/charged-заголовкам. Для Hermes-managed usage берётся из ответа Hermes (Task 1.1 `usage`) → передать в существующий путь подсчёта (тот же, что для gateway).
- [ ] **Step 5: typecheck** зелёный + `bunx vitest run` (существующие 25 тестов + новые) зелёные. **Commit** `git commit -am "feat(worker): route runs through Hermes; drop OpenRouter loop engine"`.

### Task 1.5 — UI: выбор Hermes-профиля при создании
**Files:** Modify `apps/tg-miniapp/app/api/tma/agents/route.ts` (приём `hermes_profile` + `connection_type:'hermes_managed'`), `apps/tg-miniapp/app/agents/new/page.tsx` (поле).
- [ ] **Step 1:** В create-роуте принять `body.hermes_profile` (trim, ≤200) и при `connection_type==='hermes_managed'` писать его в INSERT (колонка 0045). Валидировать: managed → hermes_profile обязателен.
- [ ] **Step 2:** В форме `/agents/new` для члена: селект «Hermes-профиль» (MVP: текстовое поле имени профиля, напр. `backend-eng`) при выборе «движок: наш Hermes». (Список профилей по API недоступен — `/v1/profiles`=404; вводим имя руками; авто-список — Фаза 2.)
- [ ] **Step 3: typecheck** обоих приложений зелёный. **Commit** `git commit -am "feat(tma): pick Hermes profile on agent create"`.

### Task 1.6 — Деплой Фазы 1 + E2E (single profile)
**Где:** прод (миграции вручную → деплой → проверка).
- [ ] Применить `0045` на проде вручную (`scp` + `sudo -u postgres psql aiag -f`).
- [ ] Env Фазы 0.3 на сервере №1 уже задан → деплой: `gh workflow run deploy-production.yml --ref feat/r2-readiness -f ref=feat/r2-readiness -f apps=tma,agent-worker`; затем `pm2 restart tma agent-worker --update-env && pm2 save` под root.
- [ ] **E2E:** создать агента с `connection_type=hermes_managed`, `hermes_profile=backend-eng` (профиль, который реально есть на боксе) → запустить из TMA → ожидать реальный ответ от Hermes (не заглушку) + списание кредитов (`settleRun`). Прогон без Hermes-маршрута → честный статус, не OpenRouter.

---

## ФАЗА 2 — Мульти-профиль, provisioning, run-trace (после доказанного MVP)
*Зависит от Фазы 1. Каждый под-пункт: typecheck/тест + commit. SSH к боксу — один батч-коннект.*

### Task 2.1 — Спайк на боксе: мультиплекс vs gateway-per-profile
- [ ] ОДИН батч-коннект: проверить, отдаёт ли один gateway РАЗНЫЕ профили (POST `/v1/chat/completions` с `model:"alisa"` vs `model:"backend-eng"` — ответы из разных профилей?) ИЛИ `/v1/models` показывает только привязанный. Если только один — включить multiplex в config (v0.17 opt-in) и перепроверить; замерить RAM (`docker stats`/`free`) при N профилях. Записать в `docs/superpowers/specs/hermes-phase0-results.md`.

### Task 2.2 — Provisioning профиля при создании/найме
- [ ] `apps/agent-worker/src/hermes-control.ts`: `ensureProfile(profileName, cloneFrom?)` — через SSH-команду на боксе (или локальный control-агент) `hermes profile create <name> [--clone-from <tpl>]` + патч `base_url`=наш `:4000` + `AIAG_GATEWAY_KEY` (ключи создателя НЕ копируются). Идемпотентно. Вызывать на create (member) и на hire (профиль-per-наниматель `<agent>_<hirer>`).

### Task 2.3 — Run-trace из Hermes /events SSE
- [ ] Для Hermes-прогона подписаться на `/v1/runs/{id}/events` (SSE) → маппить tool-события в существующий `capturedToolCalls` → `recordToolCalls` (вне settleRun). UI RunTrace без изменений (источник = наша таблица). (Требует перехода с `/v1/chat/completions` на `/v1/runs` для tool-видимости — оценить в 2.1.)

### Task 2.4 — Connect-your-own-Hermes (ZERO-комиссия)
- [ ] `connection_type='hermes_own'`: агент хранит свой Hermes URL+ключ (AES-GCM, как external_openai); `resolveUpstream` → `isExternal:true` → settleRun ZERO. Валидация URL через `validateExternalUrl` (SSRF). UI: «свой Hermes URL».

---

## Не входит (отдельные треки)
On-chain выплаты/кошелёк (аудит TON), арт персонажей, минт membership-NFT коллекции (гейт уже готов), массовый managed-Hermes для не-владельцев (требует RAM-планирования по Task 2.1).

## Self-Review
- **Покрытие:** связность (Ф0) · клиент (1.1) · схема (1.2) · заголовки/allowlist (1.3) · маршрут+удаление loop (1.4) · UI (1.5) · деплой+E2E (1.6) · мультиплекс/provisioning/trace/own-Hermes (Ф2). Сценарий основателя («создать профиль → исполняется в Hermes → нанять») закрыт MVP (1.x) для существующего профиля, провижининг новых = 2.2.
- **Плейсхолдеры:** код в 1.1/1.2/1.3/1.4 конкретный; `extraHeaders` определены в 1.3 и потребляются в 1.4; `hermesChat`/`hermesEnabled` определены в 1.1 и потребляются в 1.4.
- **Типы:** `Upstream.extraHeaders?` добавляется в 1.4-Step1; `hermesChat` usage-поля совпадают с settleRun-путём (1.4-Step4).
