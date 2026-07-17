# AIAG session 2026-07-07 — reorg + knowledge audit

## Репо-реальность (проверено разведкой)
- Живой прод: web (ветка `master`) + TMA (ветка `feat/r2-readiness`) — ОБА в монорепо `github.com/massmindmaker/aiag-marketplace`.
- `agent-market` — МЁРТВЫЙ огрызок: сплит 2026-06-12, отстал на 37 коммитов, НЕ git-форк, историю не делит. Для будущего сплита — re-seed из HEAD, не воскрешать.
- `aiag-web` — скаффолд без `.git` (Фаза-2 web-раскола не начата).

## Решение основателя 2026-07-07
- Полиреп (1 продукт = 1 репо со своим деплоем) = ЦЕЛЕВАЯ архитектура, ОТЛОЖЕНА в отдельный GSD-проект ПОСЛЕ фикса денежных багов. Эта сессия = чистка + документирование.
- Чистка = всё безопасное. Баги = issue сейчас, фикс позже.

## Аудит безопасности (Opus 2026-07-07)
- CRIT (issue #4): TON топ-ап — чеканка баланса, нет глобального дедупа on-chain tx_hash (topup-reconciler.ts; 0019_ton_wallets.sql:34 tx_hash без UNIQUE).
- HIGH (issue #5): наём списывает с ВЛАДЕЛЬЦА агента, а не нанимателя (agent-runner.ts дебетует agent.tg_user_id; run ставит hirer). Противоречит SECURITY.md.
- MED×2 (topup pre-check рассинхрон; payouts TOCTOU), LOW×3 (OpenRouter margin-fallback; jwt-denylist fail-open без Upstash; calc new Function безопасен).
- Чисто: секреты (нет закоммиченных .env/литералов; BYOK=AES-256-GCM+last4), settleRun атомарен+guarded, JWT HS256-pin+iss/aud+fail-hard+nginx-strip, next 14.2.33, SQL prepared, SSRF-гард.
- Открытые SECURITY-TODO: eval-runner nsjail, VPS root-пароль, jwt-denylist fail-open без env.

## Знание/чистка
- graphify восстановлен: 9554 узла / 12854 рёбра / 742 сообщества (`graphify update .`; держать локально, НЕ коммитить 8.45MB) — старое «8673» устарело.
- Каноническая структура знания → docs/KNOWLEDGE-STRUCTURE.md: канон=SoT · Serena=код/сессия · graphify=AST · LightRAG=ресёрч · memgraph=сущности · auto-memory=факты · DESIGN=дизайн.
- Чистка: 18 worktree-gitlink'ов из индекса, pnpm-workspace.yaml + package-lock.json удалены (bun — канон), сирота aggregator-plan-01 снесена, graphify-out в .gitignore.
- Issues на aiag-marketplace: #4 CRIT, #5 HIGH, #6 chore, #7 docs, #8 epic-полиреп.

## Не трогать
- `hermes/` — активная рабочая папка Hermes local-bridge (68 .py, scripts/, .planning/.serena) + plaintext OAuth-креды tmp_client_secret.json/tmp_token.json на диске (вне git).
