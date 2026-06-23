# TMA «Agents Market» — бэклог до полной готовности (аудит 2026-06-23)

Полный 108-аудит (9 агентов). Полный вывод: `tasks/wmwyzht3a.output`. Ветка работ: `feat/r2-readiness` (off `feat/r1.0-wave0-consolidated`).

## 108-оценки (средняя 71.6/108 ≈ 66%)
| Ось | /108 |
|---|---|
| Безопасность money-path | 79 |
| Дизайн / анимация | 76 |
| Планы (ревизия) | 73 |
| Мобайл | 71 |
| Telegram SDK | 71 |
| TON | 71 |
| UX / джорни | 71 |
| **Функционал (полнота)** | **61** ← слабейшее |

## ВОЛНА 1 — P0 (безопасность денег + быстрые победы)
1.1 Live-revocation JWT (middleware.ts + jwt-denylist.ts:64) — M, money. ⚠️ нужен edge-доступный store (отложить если упрётся в инфру)
1.2 Create-time SSRF → safeFetch (external-agent.ts:40-117, agents/route.ts:160-194) — M, money
1.3 Fail-open webhook → fail-hard 503 (transfer/webhook/route.ts:64-71) — S, money
1.4 Enqueue-провал → mark failed+503 (run/route.ts:60-78) — S, money
1.5 Run pre-check баланса 402 до enqueue (run/route.ts:46-78) — M
1.6 viewport-fit=cover (layout.tsx:26-32) — S
1.7 Бюджет ×100 на дэшборде → fmtCredits (dashboard/page.tsx:426) — S
1.8 USDT в презентации — ПРОПУСК (основатель выбрал целостное vision-описание)
1.9 disableVerticalSwipes() на маунте (useAuth.ts:42-49) — S
1.10 Margin-leak guard: реестр-проверка слагов + сверка леджеров (agent-runner.ts:116-127,306-318) — M→L, money. Careful/design

## ВОЛНА 2 — P1 (ключевой недострой)
2.1 Наём=подписка agent_sessions (XL, money) — фундамент на feat/hire-memory-foundation
2.2 Изоляция памяти per-наниматель OWASP LLM06 (L, money)
2.3 App-level rate-limit topup/transfer/run (M, money)
2.4 Мультимодель per-role (XL) — founder-решение строить/убрать
2.5 AI-builder NL→spec (L)
2.6 Free-first-run грант (M)
2.7 USDT-on-TON jetton-пополнение (L, money)
2.8 On-chain выплаты авторам @ton/ton (L, money)
2.9 Расписание-вкладка агента затирает daily/weekly→interval (M)
2.10 Аренда «кр/мес» а списывается разово (M, money)
2.11 Transfer покупатель замирает на «отправлено» — поллинг (M)
2.12 Единицы бюджета при создании (new/page.tsx:208-260) — S
2.13 Telegram SafeArea 8.0 API + клавиатура (M)
2.14 Character-card сигнатура мертва (1 ассет) — M, ⚠️ нужны ассеты от основателя
2.15 Route cross-fade + входные анимации/скелетоны на мёртвых экранах (M) ← апгрейд анимации приложения

## ВОЛНА 3 — P2-P3 (полировка/мобайл/R&D)
3.1 Нативные TG-контролы (BackButton/MainButton/popups/тема/closingConfirmation)
3.2 JWT-кэш per-user (не общий ключ aiag_jwt)
... + хвосты (см. полный вывод)

## Прочно (не трогать без нужды)
settleRun атомарный дебет+наценка+daily-guard, BYOK=0, ton-proof, реконсилер, MCP+OAuth, расписания interval, transfer-iNFT, D-0/D-1.

## Deploy-gate
Money-path/security правки — на ветке, typecheck-зелёный, миграции вручную к проду ДО деплоя, founder go перед прод-деплоем.
