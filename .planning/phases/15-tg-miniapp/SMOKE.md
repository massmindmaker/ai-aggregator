# Phase 15 — Smoke test transcript

Manual end-to-end smoke for the Telegram Mini App stack
(`apps/tg-miniapp` + `apps/agent-worker`).

> Fill in each section as you go. Keep this file in master after the run
> for auditability.

---

## 0. Pre-deploy checklist (HUMAN)

These must be in place on the VPS **before** triggering deploy:

- [ ] DNS A-record: `app.ai-aggregator.ru` → VPS public IP
- [ ] TLS cert: `certbot --nginx -d app.ai-aggregator.ru`
- [ ] Nginx vhost installed: copy `ops/nginx/aiag-tma.conf` →
      `/etc/nginx/sites-available/aiag-tma`, `ln -s` into
      `sites-enabled/`, `nginx -t && systemctl reload nginx`
- [ ] BotFather configured (`@aiag_bot`):
  - `/setdomain` → `app.ai-aggregator.ru`
  - `/newapp` (Mini App) → URL `https://app.ai-aggregator.ru/tg`
  - `/setmenubutton` → text `Открыть AIAG`, URL same
- [ ] `/srv/aiag/shared/.env` contains:

  ```ini
  # Phase 15 — TMA + agent-worker
  TG_BOT_TOKEN=<from BotFather>
  TMA_JWT_SECRET=<openssl rand -hex 32>
  TONCENTER_API_KEY=<from toncenter.com>
  TON_RECEIVER_ADDRESS=UQ...
  REDIS_URL=redis://127.0.0.1:6379
  OPENROUTER_API_KEY=<for Hermes 4 405B>
  TMA_APP_BASE_URL=https://app.ai-aggregator.ru/tg
  NEXT_PUBLIC_TONCONNECT_MANIFEST_URL=https://app.ai-aggregator.ru/.well-known/tonconnect-manifest.json
  ```

- [ ] PM2 processes registered on first deploy:

  ```bash
  cd /srv/aiag/tma/current/apps/tg-miniapp
  PORT=3100 pm2 start "bun run start" --name tma --max-memory-restart 600M
  cd /srv/aiag/agent-worker/current/apps/agent-worker
  pm2 start "node dist/index.js" --name agent-worker --max-memory-restart 500M
  pm2 save
  ```

  (omit `PORT` env when registering so deploy's healthcheck skips —
  Next still binds 3100 because `next start -p 3100` is passed via args)

---

## 1. Deploy

- [ ] `gh workflow run deploy-production.yml -f apps=tma,agent-worker`
- [ ] Run id: `_________________`
- [ ] Completion status: `_________________`

---

## 2. Liveness

- [ ] `curl -fsS https://app.ai-aggregator.ru/tg/health` → 200
  - Response: `_________________`
- [ ] `curl -fsS https://app.ai-aggregator.ru/.well-known/tonconnect-manifest.json` → 200 JSON
- [ ] `pm2 status` shows `tma` + `agent-worker` `online`, restarts=0
- [ ] No fresh errors in `pm2 logs tma agent-worker --lines 200`

---

## 3. Telegram flow (HUMAN, in Telegram client)

- [ ] Open `t.me/aiag_bot` → `/start` → tap menu button "Открыть AIAG"
- [ ] Mini App opens; profile name visible in header
- [ ] Network: `POST /tg/api/tma/auth/verify` returns 200 (silent)
- [ ] Subsequent reload — no re-verify (JWT cached in CloudStorage)

---

## 4. Agents CRUD

- [ ] `/agents` → "Создать агента" → выбрать шаблон **Аналитик**
- [ ] Submitted → 201, list shows the new agent
- [ ] Open detail → system_prompt rendered, history empty

---

## 5. Agent run (round-trip)

- [ ] Send message: `найди погоду в Москве и посчитай 18*5`
- [ ] UI shows `…думает` bubble within 1s
- [ ] Poll: `runs[0].status` transitions `pending` → `running` → `completed`
- [ ] DM from `@aiag_bot` arrives within ~5s of completion:
  `✓ Агент Аналитик готов … <link>`
- [ ] Cost displayed in UI matches DM (delta ≤ 0.01 ₽)

---

## 6. TON wallet linking & top-up (testnet)

- [ ] Profile → Кошелёк → Connect Tonkeeper testnet
- [ ] Row inserted in `ton_wallets` (verify via psql)
- [ ] Top-up 100₽ via TON testnet
- [ ] `payments.status = 'completed'` after reconcile
- [ ] Balance increases by 100₽ in profile header

---

## 7. Marketplace → use-in-agent

- [ ] Open `/market` → выбрать любую опубликованную модель
- [ ] "Использовать в агенте" → пробрасывает slug в форму нового агента
- [ ] Submit → агент создан с этим model_slug

---

## 8. NFT покупка (Startonus)

- [ ] `/nft` → выбрать коллекцию со status=active
- [ ] Покупка через TonConnect → BOC tx hash captured
- [ ] Startonus webhook (POST `/tg/api/tma/nft/webhook`) приходит → запись в `nft_purchases.status='delivered'`

---

## 9. Negative cases

- [ ] Запрос без JWT → 401 `no_token`
- [ ] Запрос с битым JWT → 401 `invalid_token`
- [ ] Превышение бюджета агента → run помечен `failed`,
      `error='budget_exceeded'`, DM с ⚠️
- [ ] Worker max_iterations → `failed` + DM

---

## 10. Final sign-off

- Date: `__________`
- Operator: `__________`
- Release tag: `__________`
- Notes / regressions / TODO: `__________`
