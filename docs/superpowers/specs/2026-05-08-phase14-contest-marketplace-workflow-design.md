# Phase 14 — Contest → Marketplace Workflow Design

**Status:** Design (no code)
**Date:** 2026-05-08
**Phase dir:** `.planning/phases/14-contest-marketplace-workflow-design/`
**Depends on:** Phase 7 (Supply) — `contests`, `contest_submissions`, `evaluations`, `models`, `model_upstreams`, `author_earnings`, `payouts`
**Out of scope:** код, миграции, API endpoints — только спецификация и wireframes.

---

## 1. Зачем

Между «победитель определён» и «автор получил деньги на счёт» сейчас зияющая дыра. Тейблы есть (Plan 07), страницы-заглушки есть (`/admin/contests/[slug]`, `/me/submit-model`, `/admin/payouts`, `/dashboard/earnings`), но связного flow нет:

- кто и когда нажимает «опубликовать»;
- куда физически уезжает модель (Fal.ai upload? proxy на их API? VPS k3s?);
- как `author_earnings` начисляется автоматически на каждый settled gateway-вызов;
- как KYC и налогообложение интегрированы в payout (НПД / ИП / физлицо);
- что происходит, если победитель — несовершеннолетний / отказывается / модель деградирует.

Этот документ закрывает 6 шагов end-to-end + предлагает schema-добавки и UX wireframes.

---

## 2. Workflow narrative — 6 шагов

### Step 1 — Submission accepted (contest closed, score ranked)

Триггер: `contest.status` переходит в `closed` (по `ends_at`). Cron `closeContestsCron` ежечасно:

1. Финализирует private score: `evaluations.is_final = true` для всех submissions данного конкурса.
2. Ранжирует submissions по `private_score` desc, проставляет `contest_submissions.final_rank`.
3. Призовой фонд (`contest.prize_pool_rub`) распределяется по `contest.prize_distribution` (jsonb, например `{"1":50, "2":30, "3":20}`) → создаются записи в `prize_awards` (новая таблица, см §3).
4. **Уведомления (TG + email)**: всем top-K — «вы заняли N место, призовые X₽ начислены, доступна публикация модели».

State после Step 1: победители видят prize money в `/dashboard/earnings`, но модель ещё **не в marketplace**.

### Step 2 — Admin reviews top-K → "Publish as marketplace model"

Внутри `/admin/contests/[slug]` — таблица submissions с фильтром `final_rank ≤ K` (K из `contest.publish_top_k`, default 3).

Каждая строка имеет CTA **«Опубликовать как marketplace-модель»** → открывает modal (см wireframe 01) с полями:

- **Slug** модели (auto-suggested: `contest-{slug}-{rank}` → редактируется).
- **Display name** + краткое описание (на русском).
- **Hosting strategy** (см §6) — radio: cloud-API wrap / hosted-on-AIAG / self-hosted by author.
- **Pricing** — gateway уже знает `cost_rub`, admin может override.
- **Revshare tier preview** — показывает, на каком tier автор сейчас (см §4).
- **Tags** — обязательно `🏆 contest-winner` + `from {contest.slug}` + custom.
- Чекбокс «Автор подтвердил публикацию» (заполняется после Step 3 — Step 2 не отправит модель live, пока чекбокс не получен).

После сабмита формы:
- `contest_submissions.published_model_id` заполняется (см §3).
- Создаётся запись в `models` со связями `derived_from_contest_id`, `author_user_id`.
- Модель в статусе `pending_author_consent` — **не показывается в `/marketplace`**.
- В TG/email автору летит invite-ссылка на consent screen (Step 3).

### Step 3 — Author consent

Автор открывает уведомление → лендится на `/me/contest-wins/[submission_id]/publish` (wireframe 02) — там:

- Поздравление + рекап (название модели, hosting strategy выбранный admin'ом, ожидаемый revshare tier).
- T&C (договор оферты автор-AIAG, ссылка на `/legal/author-agreement`).
- Чекбоксы:
  - [ ] Я подтверждаю, что обладаю всеми правами на эту модель.
  - [ ] Я принимаю условия revshare (70/75/80/85% по tiers).
  - [ ] Я согласен на размещение в marketplace под брендом AIAG.
  - [ ] Я подтверждаю, что персональные данные обработаны согласно 152-ФЗ.
- Optional: Bank details (если автор хочет сразу настроить payout — но KYC отдельно, Step 6).
- Кнопка **«Опубликовать»** → переводит модель в статус `live`.

После сабмита:
- `contest_submissions.published_at = now()`.
- `models.status = 'live'`, появляется в `/marketplace`.
- Бэкап copy-paste consent текста сохраняется в `consent_records` (audit trail для 152-ФЗ).

### Step 4 — Live in `/marketplace` с badge

Модель появляется на `/marketplace` (wireframe 03):
- Badge **🏆 contest-winner** (золотистый, accent color).
- Tooltip **«Победитель конкурса XYZ — N место»** → ссылка на closed leaderboard.
- В model-detail page карточка автора (имя/handle, avatar, ссылка на профиль).

SEO-эффект: leaderboard страница и model-detail взаимно линкуются — отличный signal для индексации Yandex.

### Step 5 — Gateway settlement → автоначисление revshare

Каждый успешный gateway-вызов проходит через `settle_charge` (Phase 04). После этой функции — новый trigger/job `accrue_author_earnings`:

```sql
-- Псевдокод (не код этой фазы)
INSERT INTO author_earnings (
  user_id, model_id, gateway_request_id,
  gross_rub, tier_pct, net_rub, status, created_at
) VALUES (
  m.author_user_id, m.id, r.id,
  r.cost_rub, current_tier_pct(m.author_user_id), r.cost_rub * tier_pct, 'pending', now()
);
```

Поведение:
- Срабатывает только если `models.author_user_id IS NOT NULL` (то есть модель — авторская).
- `tier_pct` берётся из VIEW/функции `current_tier_pct(user_id)` (см §4 — sticky thresholds).
- `status='pending'` 30 дней — buffer на refunds (см §7 deg edge case).
- После 30 дней cron `finalizeEarningsCron` переводит `status='available'`.

### Step 6 — Payout flow

Автор → `/me/earnings/payout` (wireframe 05). Можно вывести только сумму со `status='available'` ≥ `min_payout_rub` (1000₽ default).

Forms:
1. Сумма (≥1000, ≤available_balance).
2. KYC статус (если `users.kyc_status != 'verified'` — блок с CTA «пройти верификацию» → wireframe 06).
3. Реквизиты (auto-fill из `users.bank_details` если есть, иначе форма + checkbox «сохранить»).
4. Налоговый расчёт preview:
   - **НПД (самозанятый):** `payout_rub × 1.0` (автор сам платит 6% через ФНС, AIAG передаёт чек).
   - **ИП УСН 6%:** `payout_rub × 1.0` (автор сам), AIAG передаёт акт.
   - **Физлицо:** `payout_rub × 0.87` — AIAG удерживает 13% НДФЛ как налоговый агент.
5. Кнопка submit → создаёт запись в `payouts` (status='requested').

Дальше:
- `/admin/payouts` queue → manual review (или auto-approve если `auto_payout_enabled` + KYC verified + сумма ≤ `auto_payout_cap_rub` 50k).
- При approve — bank transfer (СБП/р/с), обновляется `payouts.status='paid'`, `paid_at`, `tx_ref`.
- Email + TG автору: «Перевод X₽ отправлен, реф ZZZ».

---

## 3. Schema additions (proposed)

Добавления к существующим таблицам Phase 07. **Только design — миграции пишутся в Phase 14.1 (execute).**

### 3.1 `contest_submissions` — связь с published model

```
ALTER TABLE contest_submissions
  ADD COLUMN published_model_id uuid REFERENCES models(id) ON DELETE SET NULL,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN final_rank int,
  ADD COLUMN author_consent_id uuid REFERENCES consent_records(id);

CREATE UNIQUE INDEX idx_csubs_pubmodel ON contest_submissions(published_model_id) WHERE published_model_id IS NOT NULL;
```

### 3.2 `models` — авторство и происхождение

```
ALTER TABLE models
  ADD COLUMN derived_from_contest_id uuid REFERENCES contests(id) ON DELETE SET NULL,
  ADD COLUMN author_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN hosting_strategy text NOT NULL DEFAULT 'cloud_api_wrap'
    CHECK (hosting_strategy IN ('cloud_api_wrap', 'hosted_on_aiag', 'self_hosted_by_author')),
  ADD COLUMN status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_author_consent', 'live', 'frozen', 'depublished'));
```

Замечание: `status` — поверх существующего `is_active`. На launch — миграция `is_active=true → status='live'`.

### 3.3 `users` — KYC и налоговое резидентство

```
ALTER TABLE users
  ADD COLUMN kyc_status text NOT NULL DEFAULT 'none'
    CHECK (kyc_status IN ('none', 'pending', 'verified', 'rejected')),
  ADD COLUMN kyc_type text
    CHECK (kyc_type IN ('self_employed', 'ip', 'individual')),
  ADD COLUMN kyc_verified_at timestamptz,
  ADD COLUMN tax_country text DEFAULT 'RU',
  ADD COLUMN tax_id text,                  -- ИНН (12 для физлица/самозанятого, 10 для ИП)
  ADD COLUMN bank_details jsonb,           -- зашифровано application-level (libsodium)
  ADD COLUMN dob date;                     -- для проверки совершеннолетия
```

`bank_details` JSONB schema (encrypted at rest):
```
{
  "type": "sbp" | "bank_account",
  "sbp_phone": "+7...",          // если SBP
  "bic": "044525225",             // БИК
  "account": "40817...",          // р/с
  "recipient_name": "Иванов И.И.",
  "kpp": "...",                    // если ИП/ООО
  "ogrnip": "..."                  // если ИП
}
```

### 3.4 `kyc_documents` — таблица загруженных документов

```
CREATE TABLE kyc_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type text NOT NULL CHECK (doc_type IN ('passport_main', 'passport_registration', 'inn_certificate', 'ip_egrip', 'self_employed_certificate', 'other')),
  storage_key text NOT NULL,        -- S3 key
  uploaded_at timestamptz DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason text
);
CREATE INDEX idx_kyc_docs_user ON kyc_documents(user_id);
```

### 3.5 `payouts` — KYC snapshot

```
ALTER TABLE payouts
  ADD COLUMN kyc_snapshot jsonb,    -- copy of users.{kyc_type, tax_id, bank_details (anonymized), kyc_verified_at}
  ADD COLUMN tax_withheld_rub numeric(12,2) DEFAULT 0,
  ADD COLUMN net_rub numeric(12,2),
  ADD COLUMN tax_act_storage_key text;   -- S3 ссылка на акт/чек
```

### 3.6 `prize_awards` — отдельные призовые от contest

```
CREATE TABLE prize_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id uuid NOT NULL REFERENCES contests(id),
  submission_id uuid NOT NULL REFERENCES contest_submissions(id),
  user_id uuid NOT NULL REFERENCES users(id),
  rank int NOT NULL,
  amount_rub numeric(12,2) NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'available', 'forfeited')),
  forfeited_reason text,
  created_at timestamptz DEFAULT now()
);
```

Призовые (`prize_awards`) и accrual (`author_earnings`) — **разные сущности**: первое — единоразовая выплата за победу, второе — постоянный поток от gateway calls.

### 3.7 `consent_records` (extend существующей или новая)

Существующие 152-ФЗ consents уже есть в Phase 1. Добавить doc_type `author_publish_consent` + `author_revshare_consent`.

---

## 4. Revshare tier rules

Из `Knowledge/08-business-logic.md` — 4 уровня. Sticky: достигнутый tier не понижается даже если месячные earnings падают.

| Tier | Author share | Threshold (lifetime accrued, ₽) | Auto-promote |
|------|--------------|--------------------------------|--------------|
| 1 | **70%** | 0 — 49 999 | — |
| 2 | **75%** | 50 000 — 199 999 | при достижении 50k |
| 3 | **80%** | 200 000 — 999 999 | при достижении 200k |
| 4 | **85%** | 1 000 000+ | при достижении 1M |

Реализация (из §3.5 view):
```
CREATE VIEW user_tier AS
SELECT
  u.id AS user_id,
  COALESCE(SUM(ae.gross_rub) FILTER (WHERE ae.status IN ('available','paid')), 0) AS lifetime_gross_rub,
  CASE
    WHEN ... >= 1000000 THEN 0.85
    WHEN ... >= 200000  THEN 0.80
    WHEN ... >= 50000   THEN 0.75
    ELSE 0.70
  END AS tier_pct,
  CASE ... END AS tier_label
FROM users u
LEFT JOIN author_earnings ae ON ae.user_id = u.id
GROUP BY u.id;
```

Auto-promote: при INSERT в `author_earnings` checking constraint вычислит tier с учётом нового accrual.

UI: в `/dashboard/earnings` — progress bar до следующего tier, badge текущего (wireframe 04).

---

## 5. KYC flow — 3 пути

`/me/kyc` (wireframe 06). Шаг 1 — выбор типа (radio):

### 5.1 Самозанятый (НПД, 6%)

- Загрузить «Справку о постановке на учёт в качестве плательщика НПД» (PDF/JPG, до 10MB).
- Указать ИНН (12 цифр).
- **Опционально:** интеграция с ФНС API (если получим доступ — на старте manual). При отсутствии API admin manual-проверяет справку.
- AIAG передаёт чеки автору (через API «Мой налог» если есть, иначе автор сам формирует).
- Tax model: AIAG **не удерживает** НДФЛ (плательщик НПД не платит НДФЛ).

### 5.2 ИП (УСН 6%)

- ОГРНИП (15 цифр).
- ИНН (10 цифр).
- Загрузить выписку из ЕГРИП (свежая, ≤30 дней).
- Расчётный счёт + БИК (полные реквизиты).
- AIAG передаёт акт об оказании услуг (PDF, генерируется автоматом при payout).
- Tax model: автор сам платит УСН 6% с поступлений.

### 5.3 Физлицо

- Паспорт (главный разворот + регистрация) — 2 файла.
- ИНН (12 цифр).
- ДР (для проверки 18+).
- Реквизиты (СБП по телефону или р/с).
- Tax model: AIAG как **налоговый агент удерживает 13% НДФЛ** при каждой выплате, перечисляет в ФНС, формирует справку 2-НДФЛ за год.

### 5.4 Admin review

`/admin/kyc-queue` — admin manually approves/rejects документы. Auto-approve allowed только когда integrate с ФНС API (post-MVP).

State machine: `none → pending (после upload) → verified | rejected`.

---

## 6. Hosting strategies

При публикации модели admin выбирает один из трёх:

### 6.1 Cloud-API wrapping (default для contest winners)

- Автор предоставляет endpoint URL + API key (хранится зашифрованным).
- Записывается в `model_upstreams` (Phase 07 already has).
- Gateway proxy на их инфраструктуру.
- **Trade-off:** lowest implementation cost, но downtime автора = downtime модели в AIAG.
- **Cost split:** автор платит инфру (Replicate/Modal/own VPS), revshare рассчитывается от `cost_rub`, выставленного автором.

### 6.2 Hosted-on-AIAG

- AIAG загружает модель на Fal/Replicate/Together → платит infra cost из своей доли.
- **Plus:** SLA контролируется AIAG, low-latency.
- **Minus:** infra cost (Fal billing) вычитается **до** revshare calculation:
  - `gross_rub - infra_cost = net_rub` → `net_rub × tier_pct = author_share`.
- Подходит для small/medium models с высокой нагрузкой.

### 6.3 Self-hosted by author

- Автор держит у себя (свой VPS / GPU server).
- AIAG — только маршрутизатор (`model_upstreams.endpoint_url` указывает на их сервер).
- **Plus:** zero infra cost для AIAG, максимальный revshare для автора.
- **Minus:** **highest support burden** — каждый downtime → support ticket в AIAG. Поэтому требуем SLA-договор + healthcheck endpoint.
- Подходит для proprietary models, где автор не хочет давать веса третьим лицам.

**Default для contest winners:** cloud-API wrapping (если автор уже разместил на Fal/Modal/HuggingFace) или hosted-on-AIAG (если автор отдал weights).

---

## 7. Edge cases

### 7.1 Победитель отказывается публиковать

- `contest_submissions.published_model_id = NULL` навсегда.
- `prize_awards.status` остаётся `available` — автор всё равно получает призовые (за победу, не за публикацию).
- Никаких принудительных публикаций.

### 7.2 Победитель — несовершеннолетний

- При KYC `dob` показывает age < 18 → `kyc_status='rejected'` с reason `'minor_no_legal_capacity'`.
- `prize_awards.status='pending'`, не `'forfeited'` — заморожены.
- Автоматически переходят в `'available'` в день 18-летия (cron `unlockMinorPayoutsCron`).
- **Альтернативно:** разрешено родителю/опекуну забрать через notarized power of attorney → manual admin process.

### 7.3 Модель деградирует со временем

Сценарий: накопил 70%, потом начал ошибаться (error rate > threshold), пользователи просят refund.

State machine модели:
1. **Healthy:** error_rate < 1%, p95 latency < SLA. Earnings accrue normally.
2. **Warning:** error_rate 1—5% или latency >150% SLA. Алёрт автору + admin. Earnings продолжают.
3. **Frozen:** error_rate > 5% за 24h ИЛИ admin manual freeze.
   - `models.status='frozen'` → не показывается в `/marketplace`.
   - Existing API keys с этой моделью получают 503 + Retry-After.
   - Pending earnings (`status='pending'` < 30 days) остаются pending до resolution.
4. **Depublished:** автор не починил за 30 дней → `models.status='depublished'`.
   - Pending earnings (буфер 30 дней) — refunded users автоматически если в течение 30 дней gateway call.
   - `available` earnings — остаются автору (нельзя clawback после 30 дней).

Refund window: 30 дней с момента gateway call. Если в этом окне модель ушла в `frozen/depublished` — user может запросить refund, AIAG возвращает credits, deducts from `author_earnings.pending`.

### 7.4 Disputed earnings

Любая запись `author_earnings` может быть оспорена admin (`status='disputed'`) с причиной (refund / fraud / chargeback). Автор уведомляется. Resolved → `available` или `forfeited`.

### 7.5 Контент 18+, нарушающий ToS

Если post-publish модель оказывается генерирует запрещённый контент — instant `frozen`, accrued earnings (pending+available) — `forfeited`, аккаунт — `banned`. Админ вручную через `/admin/models/[id]`.

### 7.6 Author requests data deletion (GDPR/152-ФЗ)

- Account → `deleted` mode: PII anonymized.
- `models.author_user_id` остаётся (или anonymized to `[deleted-user]`).
- `payouts` уже выплаченные — сохраняются (legal req).
- Pending earnings → forfeited (или paid out до удаления).

---

## 8. Workflow flowchart

```mermaid
flowchart TD
  A[Contest closes ends_at] --> B[Cron closeContestsCron]
  B --> C[Finalize private_score + final_rank]
  C --> D[Distribute prize_pool to prize_awards]
  D --> E[Notify winners TG + email]
  E --> F[Admin /admin/contests/slug review top-K]
  F --> G{Publish as marketplace model?}
  G -->|Skip| H[Submission stays unpublished]
  G -->|Publish| I[Modal: hosting strategy + slug + pricing]
  I --> J[Create models row status=pending_author_consent]
  J --> K[Email/TG invite to author]
  K --> L[Author opens /me/contest-wins/id/publish]
  L --> M{Author consents?}
  M -->|No| N[Model stays draft, no marketplace]
  M -->|Yes| O[models.status=live, badge contest-winner]
  O --> P[Visible in /marketplace + model-detail]
  P --> Q[User makes gateway call]
  Q --> R[settle_charge debits user]
  R --> S[accrue_author_earnings inserts pending row]
  S --> T[30-day buffer]
  T --> U[finalizeEarningsCron status=available]
  U --> V{Author requests payout?}
  V -->|amount >= min_payout_rub AND kyc=verified| W[/me/earnings/payout submit]
  V -->|kyc != verified| X[Redirect to /me/kyc]
  X --> Y[Upload docs → admin review → verified]
  Y --> W
  W --> Z[payouts row status=requested]
  Z --> AA{auto_payout enabled AND amount<=cap?}
  AA -->|Yes| AB[Auto-approve → SBP transfer]
  AA -->|No| AC[Admin /admin/payouts manual review]
  AC --> AB
  AB --> AD[payouts.status=paid + tax_withheld + tax_act]
  AD --> AE[Email + TG notification]
```

---

## 9. Wireframes (см `brain/Projects/AIAG/Wireframes/p14-contest-marketplace/`)

| # | File | Purpose |
|---|------|---------|
| 01 | `01-admin-publish-modal.html` | Admin review submission → "Publish as marketplace model" CTA + hosting strategy + revshare tier preview |
| 02 | `02-author-publish-consent.html` | Автор: «ваша модель ВЫИГРАЛА → готовы публиковать?» + T&C + agreement |
| 03 | `03-marketplace-winner-badge.html` | `/marketplace` страница с моделью-победителем (🏆 badge + "from Contest XYZ") |
| 04 | `04-dashboard-earnings.html` | `/dashboard/earnings` accrued / pending / paid + 30d chart + tier progression |
| 05 | `05-payout-request.html` | `/me/earnings/payout` форма (сумма + KYC status + bank details) |
| 06 | `06-kyc-verification.html` | KYC upload form (свидетельство ИП / справка о НПД / паспорт + ИНН) |

Все wireframes используют design tokens из `brain/Projects/AIAG/Design/home.html` (`--bg #0a0a0b`, `--accent #f59e0b`, Inter / JetBrains Mono).

---

## 10. Acceptance criteria для Phase 14 (execute)

Когда Phase 14 пойдёт в execute (Phase 14.1 — schema + cron, Phase 14.2 — UI), success criteria:

1. Cron `closeContestsCron` финализирует scores и создаёт `prize_awards` записи.
2. Admin может через `/admin/contests/[slug]` опубликовать submission как model — модель уезжает в `pending_author_consent`.
3. Автор через TG link приходит на consent screen, подтверждает → модель `live`.
4. `/marketplace` отображает badge `🏆` + ссылку на закрытый leaderboard.
5. Каждый settled gateway call авто-инсертит `author_earnings` с правильным tier_pct.
6. `/dashboard/earnings` показывает accrued / pending / paid + tier progression.
7. KYC flow покрывает 3 пути (НПД / ИП / физлицо), admin может approve/reject.
8. Payout request → admin queue → SBP transfer → email + TG notification, tax_withheld посчитан корректно.
9. Edge case: incoming gateway call к `frozen` модели → 503, no accrual.
10. Все consents (publish + revshare) сохранены в `consent_records` (audit trail).

---

## 11. Open questions (для discuss-phase)

- **OQ-1:** Использовать ли SBP-by-phone как default reciving method для физлиц? Минус — лимит 100k₽/месяц на одного отправителя в СБП. Альтернатива — банковский перевод по реквизитам.
- **OQ-2:** Auto-approve payout cap — 50k₽ ок или ниже (например 20k)?
- **OQ-3:** ФНС API «Мой налог» интеграция — pre-MVP или post-MVP? Без него самозанятым придётся самим формировать чеки.
- **OQ-4:** Нужен ли «escrow» период для prize_awards (например 14 дней до зачисления, чтобы admin успел проверить cheating)?
- **OQ-5:** Для hosted-on-AIAG — кто принимает решение о cap на infra cost? Если автор сам выставил `cost_rub` слишком низко и infra > revenue — автоматически freeze или просто отрицательная маржа AIAG?

---

## 12. Dependencies на другие фазы

- **Phase 4 Gateway:** `settle_charge` нужно расширить hook'ом `accrue_author_earnings`.
- **Phase 6 Marketplace:** UI `/marketplace` + `model-detail` нужен badge + контест-блок.
- **Phase 7 Supply:** уже есть базовая схема revshare/payouts — Phase 14 надстраивает status machine + KYC.
- **Phase 8 Launch:** legal pages должны включать `/legal/author-agreement` и `/legal/contest-rules`.

---

**Owner:** founder
**Reviewer:** AIAG-tech-lead (TBD)
**Next step:** `/gsd:discuss-phase 14` → разобрать OQ-1..OQ-5 → `/gsd:plan-phase 14`.
