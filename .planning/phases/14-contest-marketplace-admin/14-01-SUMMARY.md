---
phase: 14-contest-marketplace-admin
plan: 01
subsystem: database
tags: [phase14, schema, migration, drizzle, postgres, revshare, kyc]
requires: [phase-1 baseline (consent_records table), gateway models/requests, organizations]
provides:
  - 0014_contest_marketplace.sql migration (idempotent)
  - current_tier_pct(uuid) function
  - aiag_settle_charge with accrue_author_earnings hook
  - drizzle types for new columns/tables
affects:
  - settle path (now writes author_earnings rows)
  - admin reads (KYC, prize awards, marketplace status)
tech_stack:
  added: []
  patterns: [idempotent-DDL, sticky-lifetime-tier, per-request-accrual, inner-EXCEPTION-isolation]
key_files:
  created:
    - packages/database/migrations/0014_contest_marketplace.sql
    - packages/database/src/schema/kyc.ts
    - packages/database/src/schema/prize-awards.ts
    - packages/database/src/schema/models-marketplace.ts
  modified:
    - packages/database/src/functions/settle-charge.sql
    - packages/database/src/schema/users.ts
    - packages/database/src/schema/contests.ts
    - packages/database/src/schema/earnings.ts
    - packages/database/src/schema/index.ts
decisions:
  - "models-marketplace.ts kept OUT of barrel — coexists with legacy aiModels (table ai_models). Importers MUST use named import path to avoid symbol clash."
  - "tier_pct stored both as int (0..100) and decimal (0.700..0.850) on author_earnings — int preserves backward compat with existing schema; decimal added for hook precision."
  - "Inner BEGIN/EXCEPTION around accrual hook — settlement must succeed even if accrual fails (accrual is reconcilable, settlement is not)."
  - "consent_records prerequisite enforced via DO-block precheck at top of migration; intentional loud failure if Phase 1 baseline not present."
metrics:
  duration: ~25 min
  tasks: 3/3
  completed: 2026-05-08
---

# Phase 14 Plan 01: Schema Migration Summary

Сводка по русски: создан фундамент схемы Phase 14 — миграция `0014_contest_marketplace.sql` (идемпотентная), хук начисления `accrue_author_earnings` внутри `aiag_settle_charge`, и Drizzle-типы для админ-страниц. На VPS не применяется здесь — только в плане 14-07.

## What was built

**Migration `0014_contest_marketplace.sql`** (235 + 151 = 386 строк, два коммита):
- `contest_submissions` +4 cols (published_model_id, published_at, final_rank, author_consent_id) + 2 partial indexes
- `models` +6 cols + status/hosting CHECKs + 3 indexes + `tags text[]` (W-6 fix — tags теперь top-level колонка, не jsonb)
- `users` +7 cols (KYC + tax + bank + dob) + 2 CHECKs + partial index on pending KYC
- New tables: `kyc_documents`, `prize_awards`, `email_jobs` (W-5 — нужна для plan 14-03 publish-invite очереди)
- `payouts` +2 cols (kyc_snapshot, tax_act_storage_key)
- `author_earnings` +5 cols + period_month nullable + UNIQUE(gateway_request_id) + status+available_at index
- `current_tier_pct(uuid)` функция: 0.70/0.75/0.80/0.85 по lifetime gross_rub (50k/200k/1M порог)
- `consent_records.doc_type` CHECK расширен через introspection-then-replace pattern
- Pre-check в начале миграции: `RAISE EXCEPTION` если `consent_records` отсутствует

**aiag_settle_charge** переписан c hook'ом: после settlement INSERT-ов выполняется JOIN requests↔models, и если `m.status='live' AND m.author_user_id IS NOT NULL`, вставляется per-request accrual row в `author_earnings` с `available_at = NOW()+30d`. Хук:
- Идемпотентен (`ON CONFLICT (gateway_request_id) DO NOTHING`)
- Изолирован внутренним `EXCEPTION WHEN OTHERS` — settlement не падает если accrual ломается
- `m.status='live'` — единственная авторитетная отсечка (middleware в 14-06 — оптимизация)

**Drizzle TS** обновлены: 4 модифицированных файла (users, contests, earnings ×2 секции, index) + 3 новых (kyc, prize-awards, models-marketplace). `models-marketplace.ts` намеренно НЕ ре-экспортится из barrel — символ `models` коллизировал бы с легаси `aiModels` (table `ai_models`); импортёры используют path import.

## Hook insertion point

В `aiag_settle_charge` хук помещён ПОСЛЕ двух условных `INSERT INTO gateway_transactions` и ПЕРЕД финальным `RETURN NEXT`. Локальные переменные (`_author_id`, `_model_id`, `_tier_pct`) подняты в top-level `DECLARE` (Postgres запрещает вложенный DECLARE внутри обычного блока). Idempotency реплеев гарантируется early-return ветвью выше по функции — хук недостижим при `_existing_sub > 0 OR _existing_payg > 0`.

## Deviations from Plan

Ни одной — план выполнен ровно как написан.

## Verification status

- Все grep-проверки из `<verify><automated>` Task 1, Task 2, Task 3 — PASS (вручную выполнены).
- `tsc --noEmit` НЕ запущен в этом worktree:
  - В worktree нет `node_modules` (правило проекта запрещает локальный `pnpm install`).
  - Базовый tsconfig (`packages/typescript-config/node-library.json`) задаёт `rootDir: "src"` относительно своей директории, что в любом worktree-пути под `.claude/worktrees/...` даёт TS6059 для всех файлов одинаково — pre-existing, не связано с этим планом.
  - Drizzle-типы в новых/изменённых файлах используют только примитивы из `drizzle-orm/pg-core`, уже задействованные в существующих файлах того же пакета (паттерны идентичны earnings.ts/users.ts/contests.ts).
- Миграция НЕ применена — apply через SSH-туннель к Timeweb PG в плане 14-07 (manual checkpoint).

## Self-Check: PASSED

Files:
- FOUND: packages/database/migrations/0014_contest_marketplace.sql
- FOUND: packages/database/src/functions/settle-charge.sql (modified)
- FOUND: packages/database/src/schema/kyc.ts
- FOUND: packages/database/src/schema/prize-awards.ts
- FOUND: packages/database/src/schema/models-marketplace.ts
- FOUND: packages/database/src/schema/users.ts (modified)
- FOUND: packages/database/src/schema/contests.ts (modified)
- FOUND: packages/database/src/schema/earnings.ts (modified)
- FOUND: packages/database/src/schema/index.ts (modified)

Commits:
- FOUND: 2b537ae feat(14-01): add 0014 contest_marketplace schema additions + tier function
- FOUND: 31b5ae1 feat(14-01): append accrue_author_earnings hook to aiag_settle_charge
- FOUND: b9f4c0e feat(14-01): drizzle schema additions for Phase 14 read paths
