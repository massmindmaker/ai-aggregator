# AIAG TMA — Мастер-бэклог завершённости (2026-06-26)

Сводка 4 параллельных аудитов (agent-lifecycle · money · hermes-engine · marketplace) vs канон-интент. Вердикт: **продукт ~85% построен; «дохуя R&D» = в основном ОЩУЩЕНИЕ** (доки врут в минус + managed-Hermes-визия громкая но 0% + пара честных заглушек).

## ✅ РЕАЛЬНО ГОТОВО (production-grade — не R&D, не трогать)
Создание (с нуля/шаблон/AI-builder) · наём + **изоляция памяти per-(agent,hirer)** (scope_tg_user_id, 0040) · движок stateless-loop (12-итер тул-цикл, атомарный settleRun, бюджеты, BYOK=0, D-0 маржа, A2A call_agent) · аренда-0%-автору (атомарная, идемпотентная) · публикация/клон/рейтинг · расписания/крон (атомарные) · transfer-iNFT (код; ждёт боевой E2E) · run-trace (таймлайн тулзов) · мультимодель per-role · MCP рантайм+attach+OAuth (лучший сабсистем) · скиллы (тулзы/док install) · реальный Hermes-каталог скиллов (/v1/toolsets,/v1/skills) · connect-your-own-Hermes (как BYOK на Hermes URL+key+профиль) · free-grant+баннер · воронка пополнения TON.

## 🔧 ВЫКАЧЕНО 2026-06-26 (этой сессией)
HTTP-500 fix (ambiguous status) + 0045 · мобайл-батч · клон-только-при-создании · 108-финал (run-hang P0, фейк-консент, гейт честный, AI-builder раскрыт, эмодзи→иконки, 2-буквенные монограммы, арт boyar) · реальный Hermes-каталог · template_kind→арт · видимость/сорт публикации · /skills-редирект · деньги-ясность (лейблы, fmtCredits, cost-preview, H1-фикс двойного учёта выплат).

## 🔴 ЧТО НЕ ДОДЕЛАНО

### Дешёвое, незаблокированное (могу сам)
- **Доки/канон под реальность** — убрать «враньё в минус» (помечают not-built построенное). Главный удар по «ощущению R&D». S.
- AI-builder allow-lists шире (сейчас 2 модели / 4 тулзы). S.
- Мёртвый `hermes_managed` route: либо удалить (доки перестанут врать о полу-готовности), либо дождаться managed-спайка. S/XL.
- Нативный канбан (сейчас только прокси к чужому Hermes) или честный лейбл. M.

### Большое — нужен ОСНОВАТЕЛЬ / отдельный бокс
1. **Managed-Hermes** (наша инфра водит профили для масс, кто без своего Hermes): Phase-0 спайк + `hermes profile create` control-plane + Docker-per-tenant. **Нужен отдельный бокс 4-8GB** (личный 3.8GB/92% не годится). XL. ⚠️ connect-your-own УЖЕ работает — это для масс.
2. **Выплаты авторам** — реальная отправка USDT (`sendUsdtTransfer` = stub) + аудит TON-контрактов. L. (H1-баг уже пофикшен.)
3. **Покупка/минт membership-NFT** (гейт работает, купить негде) + **ярусы** (Creator/Builder/Studio: квота+rev-share). Нужна коллекция Startonus + (для rev-share) шаг в settleRun. L.
4. **Базы знаний (RAG)** — НЕ построено. Решение founder: свой pgvector-RAG (~3-5д) vs MemTensor MemOS-sidecar (~5-8д). ⚠️ BAI-LAB «MemoryOS» = память диалогов, НЕ docs-KB.
5. **Арт 4 архетипов** (analyst/researcher/marketer/personal) — нужны видео/лица founder (boyar+alisa подключены).
6. **Агент-кошелёк / x402 / A2A-платежи** — XL, отдельный трек work3.

## Источники
docs/superpowers/specs/2026-06-26-research-{wallet-auth,nft-membership,credit-economy,memoryos-knowledge}.md · docs/specs/2026-06-25-tma-108-polish-audit.md · канон docs/canon/AIAG-CANON.md (⚠️ статусы устарели — сверять с кодом).
