# Phase 15 / Wave 07 — Deploy (PM2 + nginx) + DM notifications + smoke

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Задеплоить `apps/tg-miniapp` и `apps/agent-worker` на VPS под `app.ai-aggregator.ru/tg`, настроить nginx vhost, добавить PM2 entries, реализовать DM-уведомления через Bot API (агент закончил, баланс низкий), прогнать end-to-end smoke.

**Architecture:** PM2 управляет двумя новыми процессами: `aiag-tma` (Next standalone, port 3100) и `aiag-agent-worker` (Node BullMQ consumer). Nginx server-block `app.ai-aggregator.ru` проксирует `/tg` → 3100 + публикует `/tonconnect-manifest.json`. Notifications: helper `sendBotMessage(chatId, text|file)` через Bot API. Worker вызывает helper когда `agent_runs.status` переходит в `completed` или `failed`.

**Tech stack:** PM2, nginx, GitHub Actions deploy workflow, Telegram Bot API.

**Prereq:** Waves 01-06.

---

## File map

| Action | File | Purpose |
|--------|------|---------|
| Modify | `ecosystem.config.cjs` | Add aiag-tma + aiag-agent-worker entries |
| Create | `ops/nginx/aiag-tma.conf` | Server block for app.ai-aggregator.ru |
| Create | `apps/tg-miniapp/src/lib/bot-api.ts` | sendBotMessage helper |
| Modify | `apps/agent-worker/src/run-agent.ts` | Call notify on completion |
| Modify | `.github/workflows/deploy.yml` | Add tg-miniapp + agent-worker to build matrix |
| Create | `.planning/phases/15-tg-miniapp/SMOKE.md` | Manual smoke test transcript |

---

## Task 1: PM2 entries

- [ ] **Step 1:** В `ecosystem.config.cjs` добавить:

```js
{
  name: 'aiag-tma',
  cwd: '/srv/aiag/current/apps/tg-miniapp',
  script: 'bun',
  args: 'run start',
  env: { PORT: 3100, NODE_ENV: 'production' },
  max_memory_restart: '600M',
},
{
  name: 'aiag-agent-worker',
  cwd: '/srv/aiag/current/apps/agent-worker',
  script: 'bun',
  args: 'run start',
  env: { NODE_ENV: 'production' },
  max_memory_restart: '500M',
},
```

- [ ] **Step 2:** Build hook: `bun run --filter @aiag/tg-miniapp build` + worker copy в prebuild step deploy workflow.

---

## Task 2: nginx vhost

- [ ] **Step 1: `ops/nginx/aiag-tma.conf`**

```nginx
server {
  listen 443 ssl http2;
  server_name app.ai-aggregator.ru;
  ssl_certificate     /etc/letsencrypt/live/app.ai-aggregator.ru/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.ai-aggregator.ru/privkey.pem;

  location /tg {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
  }

  location /.well-known/tonconnect-manifest.json {
    alias /srv/aiag/current/apps/tg-miniapp/public/tonconnect-manifest.json;
    add_header Access-Control-Allow-Origin *;
  }
}
server { listen 80; server_name app.ai-aggregator.ru; return 301 https://$host$request_uri; }
```

- [ ] **Step 2:** На VPS: `certbot --nginx -d app.ai-aggregator.ru`, `nginx -t && systemctl reload nginx`.

---

## Task 3: Bot API helper

- [ ] **Step 1: `src/lib/bot-api.ts`**

```ts
const TG = `https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}`;
export async function sendBotMessage(chatId: number|string, text: string, opts?: { parseMode?: 'HTML'|'MarkdownV2' }) {
  const r = await fetch(`${TG}/sendMessage`, {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: opts?.parseMode ?? 'HTML' }),
  });
  if (!r.ok) console.error('[bot-api] sendMessage failed', await r.text());
  return r.ok;
}
export async function sendBotDocument(chatId: number|string, fileUrl: string, caption?: string) {
  const r = await fetch(`${TG}/sendDocument`, {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ chat_id: chatId, document: fileUrl, caption }),
  });
  return r.ok;
}
```

- [ ] **Step 2:** В `run-agent.ts` после `finalize()`:

```ts
const [tg] = await db.select().from(tgUsers).where(eq(tgUsers.userId, agent.ownerUserId));
if (tg) {
  await sendBotMessage(Number(tg.tgUserId),
    `✓ Агент <b>${escapeHtml(agent.name)}</b> завершил задачу.\n` +
    `Стоимость: ${totalCost.toFixed(2)}₽\n` +
    `Открыть: https://app.ai-aggregator.ru/tg/agents/${agent.id}`);
}
```

---

## Task 4: Deploy workflow

- [ ] **Step 1:** В `.github/workflows/deploy.yml` (или ops/scripts/deploy.sh) добавить:
  - `bun run --filter @aiag/tg-miniapp build`
  - rsync `apps/tg-miniapp/.next`, `public`, `package.json` to `/srv/aiag/releases/<sha>/apps/tg-miniapp/`
  - same для `apps/agent-worker/`
  - `pm2 reload ecosystem.config.cjs --update-env`

- [ ] **Step 2:** Env vars в `/srv/aiag/shared/.env`:

```
TG_BOT_TOKEN=...
TMA_JWT_SECRET=$(openssl rand -hex 32)
TONCENTER_API_KEY=...
TON_RECEIVER_ADDRESS=UQ...
REDIS_URL=redis://127.0.0.1:6379
NEXT_PUBLIC_TONCONNECT_MANIFEST_URL=https://app.ai-aggregator.ru/.well-known/tonconnect-manifest.json
```

- [ ] **Step 3: BotFather webhook**

```bash
curl "https://api.telegram.org/bot$TG_BOT_TOKEN/setWebhook?url=https://app.ai-aggregator.ru/tg/api/tma/bot/webhook"
```

---

## Task 5: End-to-end smoke (Human Gate)

- [ ] **Step 1:** Открыть `t.me/aiag_bot` → `/start` → tap Menu Button.
- [ ] **Step 2:** Mini App открывается → авторизация silent (logs `verify-init` 200).
- [ ] **Step 3:** Создать агента «Аналитик» из шаблона.
- [ ] **Step 4:** Послать сообщение «найди погоду в Москве и посчитай 18*5».
- [ ] **Step 5:** Дождаться DM от `@aiag_bot` с `✓ Готово • -X₽ • ссылка`.
- [ ] **Step 6:** Зайти в Профиль → Кошелёк → подключить Tonkeeper testnet → linked в `ton_wallets`.
- [ ] **Step 7:** Top-up 100₽ testnet → `payments.status='completed'`, balance growth visible.
- [ ] **Step 8:** Открыть Маркет → выбрать модель → «Использовать в агенте» → агент edit показывает добавленную модель.

- [ ] **Step 9: SMOKE.md** — записать транскрипт (HTTP коды, скриншоты, BOC tx hash, агент run id).

---

## Commit

```bash
git add ecosystem.config.cjs ops/nginx .github/workflows apps/tg-miniapp apps/agent-worker .planning/phases/15-tg-miniapp/SMOKE.md
git commit -m "feat(tma): deploy PM2/nginx + Bot API DM notifications + e2e smoke pass"
```

## Done when

- `pm2 status` → `aiag-tma` и `aiag-agent-worker` online ≥ 5 min без restart.
- `curl -I https://app.ai-aggregator.ru/tg/` → 200.
- `https://app.ai-aggregator.ru/.well-known/tonconnect-manifest.json` → 200 + правильный JSON.
- Smoke transcript (SMOKE.md) подписан — все 8 шагов passed.
- DM-уведомление приходит в течение 5s после `agent_runs.status='completed'`.
