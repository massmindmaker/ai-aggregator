# Gram Pricing Storefront Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Продать кредитные пакеты за Gram на витрине `/pricing` и главной, починив перед включением два критических бага платежного контура (BigInt-wiring рефрешера и инвертированный FX-ratio билдера).

**Architecture:** Витрина читает ту же server-side политику чекаута (`admin_settings['ton_checkout_policy']` → env fallback), что и чекаут, и вычисляет цену пакета по той же BigInt-формуле `ceil(grant × num/den)`, что и `createQuote` — единый источник цены. Рефрешер воркера чинится на BigInt, билдер — на экономически корректный ratio `10⁴/usdPerTon` (nanoTON за микрокредит). Рублёвые подписки (TIERS) не удаляются — legacy-данные живут, но витрина больше их не продаёт.

**Tech Stack:** Next.js 14 server components, zod, BigInt money math (никаких Number для денег), Bun/vitest.

**Spec:** План AG-TON-L `docs/superpowers/plans/2026-10-07-ton-only-launch.md` (payment contract §Global Constraints); ресёрч-выжимка 4 субагентов — в ledger `.superpowers/sdd/2026-10-09-gram-storefront/progress.md`.

## Global Constraints

- Деньги: BigInt микрокредиты, 1 кредит = 1¢ = 1000 микро; 1 USD = 100_000 микро. ЗАПРЕЩЕНЫ Number/parseFloat/Math.round для денег; BigInt из SQL/JSON — через BigInt().
- Цена витрины = та же формула, что в `createQuote` (`packages/shared/src/ton-payment-contract.ts:151-169`): `amountAtomic = ceil(grantMicrocredits × fx.numerator / fx.denominator) + additionalFeeAtomic`. Отображение: `formatNano` (BigInt /1e9).
- Никаких цен из клиента: витрина только читает; финансовые поля чекаута по-прежнему только из политики.
- `TIERS` (`apps/web/src/lib/payments/tiers.ts`) НЕ удалять и не менять — legacy-подписки и `subscriptions/create` (503 ton_only) живут как есть.
- Дефолт-пакеты (фиксируются в тестах): `credit-600` (600000), `credit-1200` (1200000), `credit-3200` (3200000), `credit-10000` (10000000) — grantMicrocredits, decimals.
- Политика витрины недоступна (503/нет строки) → витрина рендерит fallback-блок без цен и без краха, CTA «Пополнить» → `/dashboard/billing`.
- Тексты юзерского UI: «Gram (TON)», без «рублёвых» упоминаний в оплате; админ-экраны НЕ трогаем.
- Миграции: НЕТ новых миграций в этом плане.
- Каждый heavy-прогон под `flock /tmp/ai-ecosystem-build.lock`; тесты через `bunx vitest run`.
- Прод-шаги (Phase D) — только с явного подтверждения владельца в чате; для включения нужен его merchant-адрес кошелька (внешний гейт).

## Review Focus

1. **Цена витрины ≠ цена счёта** — один и тот же пакет должен показывать на витрине ровно то, что окажется в `invoice.amountAtomic`; тест в Task 3 сравнивает `buildGramPricingView` с прямым вызовом `createQuote(...)` на идентичной фикстуре (не только повтор формулы руками).
2. **BigInt-гигиена** — ни один Number не участвует в цене: JSON.parse шаблона, fx, отображение; тест на пакет 10_000_000 микро (100$ = 2e10 nano при $5/TON); BigInt обязателен как политика денег, даже когда значение в пределах 2^53.
3. **Недоступная политика** — витрина без политики/с битой строкой не 500-ит и не показывает цену 0; тест fallback-рендера.
4. **Инвертированный курс не вернётся** — builder-тест пиннит экономический смысл (1000 кредитов при usdPerTon=5 → ровно 2.0 TON), а не только цифры numerator/denominator.
5. **Протухший курс на витрине** — если fx.expiresAtMs в прошлом, витрина не показывает старую цену как живую (fallback или пометка «курс обновляется»); тест на expired-фикстуре.

---

### Task 1: Починить BigInt-wiring TON_POLICY_TEMPLATE в bootstrap

**Files:**
- Modify: `apps/worker/src/ton-payment-bootstrap.ts:413-434` (блок policyCron)
- Test: `apps/worker/src/__tests__/ton-payment-bootstrap.test.ts` (новый describe)

**Interfaces:**
- Consumes: `buildCheckoutPolicy(input: PolicyBuilderInput)` из `@aiag/shared/ton-checkout-policy-builder`; `PolicyBuilderInput.packages[].grantMicrocredits: bigint`.
- Produces: env `TON_POLICY_TEMPLATE` с JSON-числами в `grantMicrocredits` работает без `TON_POLICY_BUILDER_GRANT_INVALID` (контракт для деплоя).

- [ ] **Step 1: Написать падающий тест**

Создай ОТДЕЛЬНЫЙ тест-файл `apps/worker/src/__tests__/ton-policy-template-wiring.test.ts` (существующий bootstrap-тест не трогать): `vi.mock('@aiag/shared/server')` c фабрикой, экспортирующей `getTonUsdRate: () => Promise.resolve(5)` и `readTonFxObservation: () => ({ usd: 5, observedAtMs: Date.now() })` (другие экспорты на этом пути не вызываются); bootstrap-зависимости — как в существующем bootstrap-тесте (fixture deps + makeDatabase c `writeCheckoutPolicy`). Запусти startTonObservationFromEnv с env() + `TON_POLICY_TEMPLATE` (JSON: recipient `0:${'1'.repeat(64)}`, revision 'rev-1', finalityPolicyId/verifierVersion из env(), packages `[{ id: 'credit-1200', label: 'Basic — 1 200 кредитов', grantMicrocredits: 1200000 }]`), прокрути `vi.advanceTimersByTimeAsync(1)`. Ассерты: `writePolicy` вызван >=1 раз; переданная строка парсится JSON.parse и содержит `"grantMicrocredits":"1200000"` (builder пишет строкой) и `"network":"tvm:-3"`. Без фикса writePolicy не вызовется (builder бросит TON_POLICY_BUILDER_GRANT_INVALID в onError) — тест красный.

- [ ] **Step 2: Прогнать — должен упасть**

Run: `bunx vitest run apps/worker/src/__tests__/ton-policy-template-wiring.test.ts`
Expected: FAIL — writePolicy не вызван (builder кинул `TON_POLICY_BUILDER_GRANT_INVALID` на number).

- [ ] **Step 3: Минимальный фикс в bootstrap.ts**

В блоке policyCron (строки ~413-434) заменить прямой spread шаблона на маппинг с BigInt:

```ts
const template = JSON.parse(env.TON_POLICY_TEMPLATE) as {
  recipient: string;
  revision: string;
  finalityPolicyId: string;
  verifierVersion: string;
  packages: Array<{ id: string; label: string; grantMicrocredits: number | string }>;
  quoteLifetimeSeconds?: number;
  maxFxAgeSeconds?: number;
};
policyCron = (await import("./ton-policy-refresher.js")).createTonPolicyRefresher({
  fetchRate: () => oracle.getTonUsdRate(),
  readObservation: () => oracle.readTonFxObservation(),
  buildPolicy: ({ usdPerTon, observedAtMs }) =>
    builder.buildCheckoutPolicy(
      {
        ...template,
        packages: template.packages.map((entry) => ({
          ...entry,
          grantMicrocredits: BigInt(entry.grantMicrocredits),
        })),
      } as builder.PolicyBuilderInput,
      { nowMs: () => observedAtMs },
    ),
  writePolicy: database.writeCheckoutPolicy,
});
```

- [ ] **Step 4: Прогон — зелёный**

Run: `bunx vitest run apps/worker/src/__tests__/ton-policy-template-wiring.test.ts apps/worker/src/__tests__/ton-policy-refresher.test.ts apps/worker/src/__tests__/ton-payment-bootstrap.test.ts`
Expected: PASS все три файла.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/ton-payment-bootstrap.ts apps/worker/src/__tests__/ton-policy-template-wiring.test.ts
git commit -m "fix(ton): coerce TON_POLICY_TEMPLATE grants to BigInt before policy build"
```

### Task 2: Экономически корректный FX-ratio в policy builder

**Files:**
- Modify: `packages/shared/src/ton-checkout-policy-builder.ts:50-62` (numerator/denominator)
- Test: `packages/shared/src/__tests__/ton-checkout-policy-builder.test.ts` (если нет — создать; Apps-тест `apps/web/src/__tests__/ton-policy-builder.test.ts` обновить)

**Interfaces:**
- Consumes: `createQuote` конвертацию (`ton-payment-contract.ts:151-169`): `amountAtomic = ceil(grantMicro × num/den) + fee`.
- Produces: `fx.numerator/fx.denominator` такие, что `num/den = 10_000_000_000n / BigInt(round(usdPerTon × 1e6))` (nanoTON за 1 микрокредит при любом usdPerTon ∈ (0, 1000]); `"1000 кредитов" (1_000_000 микро)` при `usdPerTon=5` → `amountAtomic = 2_000_000_000` (ровно 2.0 TON).

- [ ] **Step 1: Обновить/написать падающие тесты**

В существующем `apps/web/src/__tests__/ton-policy-builder.test.ts` тест «encodes 5.23 USD/TON as the exact 1e6-scaled numerator» заменить на:

```ts
it('encodes the economics: 1000 credits at 5 USD/TON cost exactly 2.0 TON', () => {
  const policy = parseCheckoutPolicy(buildCheckoutPolicy({ ...baseInput(), usdPerTon: 5 }, { nowMs }));
  // 1000 credits = 1_000_000 micro; amountAtomic must be 2e9 nanoTON at 5 USD/TON
  const micro = 1_000_000n;
  const fx = policy.fx;
  const num = BigInt(fx.numerator), den = BigInt(fx.denominator);
  const product = micro * num;
  const quotient = product / den;
  const rem = product % den;
  const rounded = rem > 0n ? quotient + 1n : quotient; // ceil
  expect(rounded).toBe(2_000_000_000n);
  expect(fx.source).toBe('coingecko:the-open-network');
});
```

И добавить проверку denominator-инварианта:

```ts
it('keeps numerator/denominator inside int64 at extreme rates', () => {
  for (const usdPerTon of [0.01, 5.23, 1000]) {
    const policy = parseCheckoutPolicy(buildCheckoutPolicy({ ...baseInput(), usdPerTon }, { nowMs }));
    expect(BigInt(policy.fx.numerator) > 0n).toBe(true);
    expect(BigInt(policy.fx.denominator) > 0n);
    expect(BigInt(policy.fx.denominator) <= 9223372036854775807n).toBe(true);
  }
});
```

- [ ] **Step 2: Прогнать — RED**

Run: `bunx vitest run apps/web/src/__tests__/ton-policy-builder.test.ts`
Expected: FAIL — старый numerator при usdPerTon=5 даёт 1_000_000×5000000/1000000 = 5e6 ≠ 2e9; новый даёт ровно 2e9.

- [ ] **Step 3: Фикс формулы в builder.ts**

Заменить блок вычисления numerator (строки ~50, 61-66):

```ts
// Economic ratio: nanoTON per 1 microcredit = 10^10 / (usdPerTon × 10^6).
// 1 micro = 1e-5 USD; nanoTON = USD / usdPerTon × 1e9  ⇒  micro × 1e4 / usdPerTon.
const FX_NUMERATOR = 10_000_000_000n; // 10^10, constant
const denominator = positiveAtomicString(
  BigInt(Math.round(input.usdPerTon * 1_000_000)),
  'TON_POLICY_BUILDER_FX_INVALID',
);
```

и в объекте политики:
```ts
fx: {
  numerator: FX_NUMERATOR.toString(),
  denominator: denominator,
  rounding: 'ceil' as const,
  ...
```

(Math.round здесь допустим — это курс, не деньги; собственно деньги считаются в createQuote на BigInt.)

- [ ] **Step 4: Прогон — GREEN + смежные**

Run: `bunx vitest run apps/web/src/__tests__/ton-policy-builder.test.ts packages/shared/src/__tests__/ apps/worker/src/__tests__/ton-policy-refresher.test.ts apps/worker/src/__tests__/ton-policy-template-wiring.test.ts`
Expected: PASS (если в shared-тестах есть pin'ы старого numerator — обновить их на новую пару 10000000000/5230000).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/ton-checkout-policy-builder.ts apps/web/src/__tests__/ton-policy-builder.test.ts packages/shared/src/__tests__/
git commit -m "fix(ton): invert fx ratio in policy builder to nanoTON-per-microcredit (10^10/usdPerTon)"
```

### Task 3: Server-side источник пакетов витрины `gramPackages()`

**Files:**
- Create: `apps/web/src/lib/ton-wallet/pricing-packages.ts`
- Test: `apps/web/src/__tests__/ton-pricing-packages.test.ts`

**Interfaces:**
- Consumes: `activeCheckoutPolicy()` из `checkout-policy-source.ts`; `parseCheckoutPolicy` (zod).
- Produces:
```ts
export interface GramPackageView {
  id: string;
  label: string;
  credits: string;            // человекочитаемо: "1 200"
  amountAtomic: string;       // строка BigInt nanoTON (для отображения через formatNano)
  grams: string;              // отображаемое "2.4" — производное, см. formatGrams
}
export interface GramPricingView {
  packages: GramPackageView[];
  fxSource: string;           // policy.fx.source
  fxExpiresAtMs: number;
  stale: boolean;             // fx.expiresAtMs <= Date.now()
  testnet: boolean;           // policy.network === 'tvm:-3'
}
export function buildGramPricingView(policy: TonCheckoutPolicy, nowMs?: number): GramPricingView; // чистая, тестируемая
export async function readGramPricing(): Promise<GramPricingView | null>; // null при недоступности/битой политике (никогда не бросает)
```
- Правило цены: `amountAtomic = ceilViaBigInt(grant × num, den) + additionalFeeAtomic` — повтор формулы `convertAtomic` (BigInt, ceil при rem>0; additionalFee добавлять как BigInt). Отображение grams: `formatGrams(amountAtomic)` = BigInt-деление на 1e9 c двумя знаками (строкой, без toFixed на float: деление BigInt + ручное форматирование остатка).

- [ ] **Step 1: Падающие тесты**

```ts
import { describe, expect, it } from 'vitest';
import { buildGramPricingView } from '@/lib/ton-wallet/pricing-packages';

const policy = (over: Record<string, unknown> = {}) => ({
  revision: 'rev-1', recipient: `0:${'1'.repeat(64)}`, network: 'tvm:-3',
  finalityPolicyId: 'f', verifierVersion: 'v',
  quoteLifetimeSeconds: 600, maxFxAgeSeconds: 300,
  fx: { numerator: '10000000000', denominator: '5000000', rounding: 'ceil', source: 'coingecko:the-open-network', observedAtMs: 1_000, expiresAtMs: 61_000 },
  additionalFeeAtomic: '0',
  packages: [
    { id: 'credit-600', label: 'Стартовый — 600 кредитов', grantMicrocredits: '600000' },
    { id: 'credit-10000', label: 'Pro — 10 000 кредитов', grantMicrocredits: '10000000' },
  ],
  ...over,
}) as never;

describe('gram pricing view (storefront plan, task 3)', () => {
  it('prices 1000 credits at 5 USD/TON as exactly 2.0 grams — same math as createQuote', () => {
    const view = buildGramPricingView(policy(), 30_000);
    const big = view.packages.find((p) => p.id === 'credit-10000')!;
    // 10_000_000 micro × 1e10 / 5e6 = 2e10 nanoTON = 20.0 grams
    expect(big.amountAtomic).toBe('20000000000');
    expect(big.grams).toBe('20');
  });
  it('marks the view stale when fx has expired and keeps packages visible', () => {
    const view = buildGramPricingView(policy(), 120_000);
    expect(view.stale).toBe(true);
    expect(view.packages).toHaveLength(2);
  });
  it('includes the additional fee in the displayed amount', () => {
    const withFee = policy({ additionalFeeAtomic: '150000000' }); // +0.15 grams
    const view = buildGramPricingView(withFee, 30_000);
    const start = view.packages.find((p) => p.id === 'credit-600')!;
    expect(BigInt(start.amountAtomic)).toBeGreaterThan(BigInt('1200000000'));
  });
});
```

- [ ] **Step 2: RED**

Run: `bunx vitest run apps/web/src/__tests__/ton-pricing-packages.test.ts`
Expected: FAIL — модуль не существует.

- [ ] **Step 3: Реализация** — чистая `buildGramPricingView` по Interfaces (BigInt ceil вручную), `readGramPricing` = try { activeCheckoutPolicy() } catch { return null }. Формат grams: повторить схему formatNano из TonWalletPanel.tsx:113 (BigInt-деление на 1e9 + остаток padStart(9,'0') с обрезкой хвостовых нулей; обязательно `0.`-префикс для сумм < 1 gram, например '0.5'). Плюс прямая сверка с createQuote на той же фикстуре: `createQuote({ quoteId:'q', sourcePrice:{unit:'gateway_microcredits',amountAtomic:'10000000'}, asset, fx: policyFx, additionalFeeAtomic:'0', expiresAtMs }, [asset], nowMs)` → `amountAtomic === '20000000000'`.

- [ ] **Step 4: GREEN** — Run тот же файл: PASS.

- [ ] **Step 5: Commit** `feat(ton): gram pricing view for storefront packages`

### Task 4: Витрина /pricing — пакеты Gram

**Files:**
- Modify: `apps/web/src/app/pricing/page.tsx` (заменить currentPlanId-SQL на readGramPricing)
- Modify: `apps/web/src/app/pricing/PricingClient.tsx` (полная переделка карточек)
- Test: `apps/web/src/__tests__/ton-pricing-page.test.ts` (новый)

**Interfaces:**
- Consumes: `readGramPricing(): Promise<GramPricingView | null>` (task 3); `CryptoDisclaimer` уже на биллинге (не дублировать на витрине — короткая строка «Курс фиксируется на момент оплаты»).
- Produces: `/pricing` рендерит карточки пакетов (price «≈ 2.4 GRAM», credits «1 200 кредитов», features = «Pay-per-request AI, 1 кредит = 1 цент...»), CTA: не залогинен → `/register?callbackUrl=/pricing`; залогинен → `/dashboard/billing`. При `view === null` → блок «Пакеты скоро появятся» + CTA на биллинг, статус 200. `stale === true` → плашка «Курс обновляется — цена зафиксируется при оплате». УДАЛИТЬ: TIER_COPY, Switch месяц/год, бейдж −15%, селектор провайдеров, handleSubscribe+fetch (мёртвый код), «оплату в рублях», Enterprise-блок оставить.

- [ ] **Step 1: Падающий тест страницы** (рендер PricingClient с фикс-пропсами):

```ts
// apps/web/src/__tests__/ton-pricing-page.test.ts
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import PricingClient from '@/app/pricing/PricingClient';

const view = {
  packages: [
    { id: 'credit-1200', label: 'Basic — 1 200 кредитов', credits: '1 200', amountAtomic: '2400000000', grams: '2.4' },
  ],
  fxSource: 'coingecko:the-open-network', fxExpiresAtMs: 1, stale: false, testnet: true,
} as never;

describe('pricing storefront (task 4)', () => {
  it('renders gram package cards without ruble signs', () => {
    const { container } = render(<PricingClient isLoggedIn={false} view={view} />);
    expect(container.textContent).toContain('2.4');
    expect(container.textContent).toContain('GRAM');
    expect(container.textContent).not.toContain('₽');
    expect(container.textContent).not.toContain('рубл');
  });
  it('renders the no-packages fallback without crashing', () => {
    const { container } = render(<PricingClient isLoggedIn={false} view={null} />);
    expect(container.textContent).toContain('Пополнить');
  });
  it('marks stale fx honestly', () => {
    const { container } = render(<PricingClient isLoggedIn={false} view={{ ...view, stale: true }} />);
    expect(container.textContent).toContain('Курс обновляется');
  });
});
```

- [ ] **Step 2: RED** — модуль/пропсы не существуют.

- [ ] **Step 3: page.tsx** — убрать SQL plan_name, вызвать `const view = await readGramPricing();`, передать `isLoggedIn` (auth) + `view`. **PricingClient.tsx** — новый рендер по пропсе `view: GramPricingView | null` (тип из task 3), карточка: grams крупно, credits, 3 фичи («Pay-per-request: платите за фактические запросы», «Кредиты не сгорают», «Оплата кошельком Gram (TON)»), CTA. `testnet===true` → маленький бейдж «Testnet».

- [ ] **Step 4: GREEN + регресс** — `bunx vitest run apps/web/src/__tests__/ton-pricing-page.test.ts apps/web/src/__tests__/payments/routes.test.ts apps/web/src/lib/payments/__tests__/providers.test.ts` (последние два — не деградировали).

- [ ] **Step 5: Commit** `feat(pricing): gram credit packages storefront, drop rub tiers from public page`

### Task 5: Главная страница — секция тарифов и рублёвые тексты

**Files:**
- Modify: `apps/web/src/app/page.tsx:297-318` (pricingTiers → пакеты), `37-39,191,214-219,410-411,428,443-445,492-493,1218,1228,1290-1291` (тексты «карта РФ/рублёвая» → Gram)
- Test: обновить/добавить в `apps/web/src/__tests__/` grep-тест контента главной не обязателен; достаточно `bun run build` + ручной smoke в Step 4.

**Interfaces:**
- Consumes: `readGramPricing()` (task 3).
- Produces: главная показывает до 3 пакетов (credit-1200/3200/10000) в существующем стиле секции Pricing; hero/футер говорят «Оплата в Gram (TON)».

- [ ] **Step 1: page.tsx** — в server-части `const gramPricing = await readGramPricing();`, собрать `homePackages` (мап к текущей форме карточек: title=label, price=`≈ ${grams} GRAM`, desc=credits); текстовые правки по списку строк (37-39 metadata, 191 «Пополните баланс в Gram», 214-219 compare, 410-493 feature-строки, 1218/1228/1290-1291 — «Оплата Gram (TON)», «Крипто-оплата Gram»). Если политика недоступна — секция рендерит 3 дефолт-карточки с пометкой «≈ цена по текущему курсу» без числа? НЕТ — без политики не выдумываем цены: рендерим карточки с кредитами и строкой «Цена — на странице оплаты», CTA → /pricing.
- [ ] **Step 2: Сборка** — `bunx next build` в apps/web под flock (или `bun run --filter=web build`), ожидание: без ошибок TS.
- [ ] **Step 3: Витринные тесты страницы Task 4 не сломались** + `bunx vitest run apps/web/src/__tests__/` целиком на затронутых.
- [ ] **Step 4: Commit** `feat(home): gram pricing section, replace rub copy`

### Task 6: Смежные рублёвые тексты + messages-чистка

**Files:**
- Modify: `apps/web/src/app/docs/page.tsx:132`, `apps/web/src/app/(marketing)/marketplace/page.tsx:30,34,67`, `apps/web/src/app/(marketing)/marketplace/calculator/page.tsx:11,29`, `apps/web/src/app/dashboard/usage/page.tsx:108-111,159,194`, `apps/web/src/app/dashboard/referrals/page.tsx:109-110,127,140,194`, `apps/web/src/lib/dashboard/overview.ts:101,110,129`
- Modify: `apps/web/messages/*.json` — удалить протухшую секцию `pricing.tiers` (ru + все локали)

**Interfaces:** текстовые замены НЕ механические: «₽»→«кр» только там, где значение реально в кредитах. Рублёвые ДАННЫЕ из БД остаются в ₽ и НЕ трогаются: usage totalCostRub, referrals-бонусы (bonusReferrerRub), earnings-архив — замена знака без конверсии = ложь юзеру. Меняем только обещания оплаты: docs/marketplace/calculator «оплачивайте в рублях»→«оплачивайте в Gram (TON)». overview.ts:101 «— ₽» оставить (данные), плитка «Тариф»→«Пакет». Дополнительно billing/page.tsx:230-240: карточка «Перейдите на платный тариф… / Выбрать тариф» → «Пополните баланс кредитов… / Выбрать пакет».

- [ ] **Step 1: Замены по списку** (аккуратно, по одной строке, сохранить вёрстку).
- [ ] **Step 2: messages** — удалить `pricing.tiers.*` из всех `apps/web/messages/*.json`.
- [ ] **Step 3: Греп-проверка**: `grep -rn "₽\|рубл" apps/web/src/app/docs apps/web/src/app/\(marketing\) apps/web/src/app/dashboard/usage apps/web/src/app/dashboard/referrals apps/web/src/lib/dashboard/overview.ts` → пусто.
- [ ] **Step 4: Прогон** `bunx vitest run apps/web/src/__tests__/` (юрьёз-фолбэк тестов billing не задет) + `bunx tsc --noEmit -p apps/web`.
- [ ] **Step 5: Commit** `chore(copy): purge ruble mentions from user-facing surfaces`

### Task 7: Полный локальный гейт + деплой-артefacts

**Files:**
- Modify: `.env.example:59-73` (добавить `TON_NETWORK_PRESET=`, `TON_SETTLEMENT_DATABASE_URL=`; исправить комментарий про «mainnet-пресет включает crosscheck» → «включается явно TON_EVIDENCE_CROSSCHECK=1»)
- Modify: `docs/ops/TON-ONLY-RUNBOOK.md` (секция подъёма: добавить TON_POLICY_TEMPLATE-пример с дефолт-пакетами и maxFxAgeSeconds=300, quoteLifetimeSeconds=600)

- [ ] **Step 1: .env.example** — дополнения по списку + комментарий «TON_POLICY_TEMPLATE JSON: grantMicrocredits — обычные JSON-числа, воркер приводит к BigInt».
- [ ] **Step 2: runbook** — вставить готовый JSON-блок (recipient = `<MERCHANT_WALLET>`-плейсхолдер, помеченный «заменить на адрес владельца»).
- [ ] **Step 3: Полный гейт**: под flock — `bunx vitest run apps/web/src/__tests__ packages/shared/src/__tests__ apps/worker/src/__tests__/ton-policy-template-wiring.test.ts apps/worker/src/__tests__/ton-policy-refresher.test.ts apps/worker/src/__tests__/ton-payment-bootstrap.test.ts` → все зелёные; `bunx tsc --noEmit -p apps/web` и `-p apps/worker` чистые.
- [ ] **Step 4: Commit** `docs(ops): env examples and runbook for gram storefront enablement`

### Task 8 (ВНЕШНИЙ ГЕЙТ — прод): Деплой и включение testnet

**Владелец должен дать в чате: merchant-адрес кошелька (0:...) и явное «включаем testnet». Без этого задача не исполняется.**

Шаги (после подтверждения; исполняет контроллер сессии, не субагент):
1. Push ветки; релиз web+worker по контракту деплоя (tar → bun install 1.4.2 → build → sym-link → port-killer → pm2 restart через ecosystem).
2. `/srv/aiag/shared/.env`: web (`TON_WALLET_ENABLED=1`, `TON_WALLET_ORIGIN=https://ai-aggregator.ru`, `TON_WALLET_NETWORK=-3`), worker observe-набор + `TON_POLICY_TEMPLATE` (JSON с адресом владельца, пакеты 600/1200/3200/10000, `quoteLifetimeSeconds:600`, `maxFxAgeSeconds:300`).
3. `sudo -u postgres psql aiag -c "ALTER ROLE aiag_ton_worker PASSWORD '<генерированный>';"` (для будущего settle; хранить в секретах).
4. `pm2 restart /srv/aiag/shared/ecosystem.config.cjs --only web,worker && pm2 save`.
5. Проверки: worker `/health` ok + `pm2 logs worker` без `startup_refused` (иначе немедленный откат env — воркер умирает целиком!); `SELECT value FROM admin_settings WHERE key='ton_checkout_policy'` — живой `observedAtMs` ≤60с; `/pricing` показывает пакеты с ценами; создание testnet-счёта вручную.
6. Отчёт владельцу: скрин-стейт, ожидание его smoke-перевода, затем (отдельным подтверждением) settle: добавить `TON_RECONCILIATION_MODE=settle` + `TON_SETTLEMENT_CONFIRMATION` + `TON_SETTLEMENT_DATABASE_URL` → restart worker.

## Ссылки

- Ресёрх-доклады: `.superpowers/sdd/2026-10-09-gram-storefront/research-*.md` (4 файла этой сессии).
- Экономика: `packages/api-gateway/src/lib/pricing.ts:3-8` (1 кр = 1000 микро; 1 USD = 100_000 микро).
- Формула цены: `packages/shared/src/ton-payment-contract.ts:151-169` (convertAtomic, ceil).
