# AIAG TMA — Wireframes design spec (2026-06-01)

Board: `docs/wireframes/tma/index.html` (+ `styles.css`). Open in a browser.

## Product
The AIAG **Telegram Mini App** (@aiaggbot) — an AI-model aggregator inside Telegram.
Audience: RU users / indie devs who want any AI model without VPN, paying in ₽.
Main CTA: **create an agent** (2-click template → run). Vibe: technical, dark, amber accent.
Constraints: mobile portrait, Telegram chrome (top bar + bottom 4-tab nav), in-app webview.

## Decisions (from discovery)
- **Fidelity:** dark/amber lo-fi (not B&W) — brand is already established; user wants to *see* the real feel.
- **Scope:** full TMA (~19 artboards) — 4 tabs + agent flows + BYOK provider connection + onboarding/wallet/system + modals.
- **Ambition:** fuller — fill the currently-empty screens with real value (balance/top-up, agent cards with metrics, 2-click templates, marketplace with filters/pricing, provider connection).

## Information architecture (19 artboards)
**Агенты:** 01 список (cards+metrics+FAB) · 02 создать—выбор пути · 03 шаблоны (2-клик) · 04 с нуля (форма) · 05 подключение провайдера (BYOK) · 06 чат (streaming) · 07 раны/история · 18 настройки.
**NFT:** 08 коллекции · 14 TON Connect (модалка) · 15 минт (Startonus/TON).
**Маркет:** 09 список (поиск/фильтры/цены) · 10 карточка модели (pricing/caps/«создать агента»).
**Профиль:** 11 баланс/ключи/настройки · 12 пополнить (СБП/карта, модалка) · 16 API-ключи · 17 подключённые провайдеры.
**Система:** 13 онбординг · 19 модалки (успех/ошибка/удаление/оплата).

Happy-path core = 01→02→03/05→06; marketplace 09→10→create; profile 11→12.

## Tokens (board)
bg #0b0d10 · surface #14171c · line #252b34 · ink #e9edf2 · ink-dim #8b95a3 · amber #f59e0b · good #34d399 · danger #e06a6a · mono JetBrains Mono (all numbers/keys/ids in `.num`).
Components: phone frame 320×660 w/ tg-bar + tabbar; card, chip, btn (+ghost/sm), input/field, seg tabs, bubble (chat), fab, scrim+sheet (modals), empty, metric.

## What this fixes vs current
Current TMA screens are near-empty placeholders ("Откройте через @aiag_bot", "Пока пусто"). The wireframes give every tab real content + the missing flows: agent creation (3 paths incl. 2-click templates), the BYOK provider picker (P0 we're building: provider→key→model), chat+runs, NFT mint, balance/top-up, API keys, connected providers, settings, and the modal states.

## v3 — voice-first design decisions (brainstorm) + new flows (artboards 25-32)
Approved product model: **hybrid marketplace → "personal AI worker"** — catalog/templates are the door (2-click), the VALUE is agents that DO work inside your Telegram. Telegram access is **official only**: Bot API (channels/groups) + Telegram Business (DMs on your behalf). **MTProto userbot = avoided** (ToS/ban risk; deep opt-in "at your own risk" much later). Crypto-only (TON/USDT), rubles removed.

18-point feature verdict (Польза6+Дифф6+Реализ/безоп6): CORE = agent-as-Telegram-bot (16), agent in channels/chats (15), agent memory (13), tools (12); kanban = **task board** (Очередь→В работе→Готово). LATER = connect-own-agent/Hermes (12, power-user), agent groups + shared memory (11), group chat (11). SKIP = MTProto (11, unsafe). + **Tools marketplace** added (browse/equip tools: built-in web-search/image/Telegram + custom/MCP).

Agent-creation workflow = **wizard "Кто → Где → Что"**: Step1 Кто (entries: «Опиши словами» AI-builder + «Каталог шаблонов» 2-click + «с нуля»), Step2 Где (paste @BotFather token → channel/group/DM-Business), Step3 Что делает (tasks: schedule/cron · keywords · on-demand) → Live. First run free.

**Hermes** (clawvader-tech): self-hosted personal agent (FastAPI :9119, SSE chat, cron, sub-agent spawn, vision/OCR, Bot-API+initData, Cloudflare tunnel, no crypto). "Connect your own agent" = point AIAG at the Hermes endpoint URL + bearer (extends the P0 BYOK). Validates our direction: cron→task board, tools, sub-agents→agent groups, Bot-API→official Telegram path.

New artboards: 25-27 creation wizard · 28 Telegram-deploy detail · 29 tasks kanban · 30 tools marketplace · 31 equip-tools · 32 connect-own-agent (Hermes). Full board now **32 artboards**.

## Next
Review → iterate (visual language / key-screen content / coverage). Then hi-fi or straight to TMA code (the BYOK provider flow #05/#17 maps to the P0 build already underway — see `project-provider-connection-p0`).
