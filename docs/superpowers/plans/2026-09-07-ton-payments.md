# Aggregator: TON alongside RUB Implementation Plan

> **Для исполнителей:** REQUIRED SUB-SKILL: Superpowers executing-plans или уже разрешённый subagent-driven-development. Выполнять task-by-task с RED/PASS/spec+quality review и точным scoped commit.

**Goal:** Добавить TON native и allowlisted stablecoin invoices, chain reconciliation и однократное начисление доступных gateway credits, сохранив RUB.

**Architecture:** Отдельный TON rail с точными суммами вызывает существующий merchant ledger, не банковский amountRub adapter. Сначала чистый контракт/fixtures, затем native DB, после — ограниченный testnet proof.

**Tech Stack:** TypeScript, Bun/Vitest, PostgreSQL, TON Connect для Web; RPC через replaceable verifier.

**Spec:** [общая спецификация payment/evidence](/home/bob/Projects/ai-aggregator/docs/ecosystem/payment-and-evidence-design.md), [исследование](/home/bob/Projects/ai-aggregator/docs/research/2026-09-07-ai-hub-reviewed-synthesis.md).

## Global Constraints

- Testnet first (`tvm:-3`); mainnet keys/funds/paid providers/production migrations/deploy запрещены в этом локальном этапе.
- Native + allowlisted jetton identity по network/master/decimals, exact integer amounts; display ticker не идентификатор.
- Merchant ledger продукта, PaymentRail и будущий agent wallet разделены. Никаких seed/root private keys в frontend/LLM/logs.
- Existing DB guard до клиента/import/mutation, один heavy run под `flock /tmp/ai-ecosystem-build.lock`; сохранять чужие edits.
- Unknown outcome не разрешает новую отправку денег. Web poll/sweep используют один domain settlement.
- Migration filename/version фиксировать в focused task brief по фактическому manifest перед кодом; не переиспользовать уже применённый номер/checksum.
- Тестовые fixtures, реальная testnet транзакция и production acceptance имеют раздельный evidence.

---


### Task AG-TON1: точный quote/asset contract

**Create:** `packages/shared/src/ton-payment-contract.ts`, `packages/shared/src/__tests__/ton-payment-contract.test.ts`.
**Interfaces:** `Asset = { network: 'tvm:-3'; kind: 'native'; decimals: 9 } | { network: 'tvm:-3'; kind: 'jetton'; masterAddress: string; decimals: number }`; `parseAtomic(text:string,decimals:number):bigint`; `sameAsset(a:Asset,b:Asset):boolean`. Invoice wire fields определены в спецификации; rational FX = integer numerator/denominator и explicit rounding.

- [ ] RED и минимальный exact parser; reject sign/exponent/NaN/лишние decimals/нулевую сумму. Preallocation bound v1: вход≤96символов, allowlisted decimals0…18, atomic representation≤78цифр; проверить до BigInt/pow/multiplication. До записи BIGINT проверить0…9223372036854775807 (strictly positive для invoice), credit/FX intermediate overflow отвергнуть; не обрезать. Чистый parser может вернуть bigint за DB диапазоном, persist boundary обязана его отклонить:

```ts
import { expect, test } from 'vitest';
import { parseAtomic, sameAsset } from '../ton-payment-contract';
test('amount has no Number roundtrip', () => {
  expect(parseAtomic('9007199254740993.000001', 6)).toBe(9007199254740993000001n);
  expect(() => parseAtomic('1e3', 9)).toThrow();
  expect(() => parseAtomic('0.0000000001', 9)).toThrow();
});
test('jetton identity includes master', () => {
  const a = { network:'tvm:-3', kind:'jetton', masterAddress:'0:'+'1'.repeat(64), decimals:6 } as const;
  expect(sameAsset(a, {...a, masterAddress:'0:'+'2'.repeat(64)})).toBe(false);
});
```

- [ ] Run `bunx vitest run packages/shared/src/__tests__/ton-payment-contract.test.ts`; записать RED, реализовать и повторить PASS. Добавить случаи normalized server allowlist, native/jetton, wrong network, oversized input/decimals до allocation, DB-boundary±1, rational conversion/rounding, oversized FX operands/denominator0 и stale quote.
- [ ] Ни новую цену, ни mainnet stablecoin master не угадывать: config allowlist по проверенному issuer/network. Пока разрешён только явно названный test asset. Commit после focused types/review.

### Task AG-TON2: durable invoice и ledger settlement

**Create:** `packages/database/src/schema/ton-payments.ts`, `packages/database/src/ton-payments.ts`, `packages/database/scripts/__tests__/ton-payments.native.integration.test.ts`; новая additive SQL migration в `packages/database/migrations` по следующему manifest ID; подключение schema exports/mandatory native suite.
**Interfaces:** `createTonInvoice(ownerId, orderId, idempotencyKey, quote): Invoice`; `settleTonInvoice(invoiceId, VerifiedChainCredit): Receipt`; обе функции получают серверные owner/order, persisted payload immutable. `VerifiedChainCredit` содержит network/asset/recipient/amount/reference/tx/LT/message/block anchor/verifierVersion, не клиентский success flag.

- [ ] Native RED: 20 concurrent create с одним payload дают один invoice; изменённый amount с тем же key даёт conflict; чужой owner не видит invoice; две invoices не потребляют один incoming event.
- [ ] Реализовать additive tables invoices/chain_events и unique keys. Единый lock order org→invoice→chain event/refund, совместимый с organization→admission/payment; concurrency tests включают opposing refund/settlement. Event registration, invoice CAS, доступные org credits и ledger write — одна транзакция; получить unit conversion из принятого gateway ledger, не менять историческую единицу.
- [ ] Native RED/PASS: webhook poll и sweep racing дают один credit/receipt; DB failure откатывает всё; crash-after-commit возвращает тот же receipt; поздняя/неполная/избыточная оплата review, не выдача.
- [ ] Guarded native fixture test должен вызывать реальные domain functions. Добавить suite в `test:database-baseline`, fresh/no-op/checksum/rollback и денежную conservation проверку. Записать actual command/env/result; не запускать naked DB migration.

### Task AG-TON3: chain verifier и restartable sweep

**Create:** `apps/worker/src/ton-payment-reconciler.ts`, `apps/worker/src/__tests__/ton-payment-reconciler.test.ts`; bounded RPC adapter и fixtures рядом с этим модулем. **Modify:** `apps/worker/src/index.ts` только controlled startup/cleanup.
**Interfaces:** `verifyChainCredit(invoice, trace, policy): VerifiedChainCredit | {state:'observed'|'review_required'; reason:string}`; `reconcileTonInvoices({cursor, limit}): {nextCursor,processed}`. API check передаёт только invoiceId в ту же domain boundary, не отдельную копию chain logic.

- [ ] RED fixtures: fake jetton master/notification, wrong network/recipient/reference/amount/decimals; bounced/aborted transaction, incomplete jetton path, absent finality anchor; все без credit.
- [ ] Реализовать normalizer/allowlist и pinned finality policy. До реального testnet сверить fields выбранного RPC с TON docs и сохранить sanitized success/failed trace; indexer flag не объявлять cryptographic proof.
- [ ] Test cursor overlap/gap/rate-limit/backoff, restart до/после DB commit, evidence out of order. Poll timeout сохраняет pending/observed; replay безопасен. Log только IDs/reasons, без secrets.
- [ ] Run focused `bunx vitest run apps/worker/src/__tests__/ton-payment-reconciler.test.ts` и native suite после wiring; проверить disabled config = worker не обращается к сети.

### Task AG-TON4: Web checkout с сохранением RUB

**Create:** `apps/web/src/app/api/payments/ton/invoices/route.ts`, `apps/web/src/app/api/payments/ton/invoices/[id]/route.ts`; Web checkout component в текущем topup UI; focused route/UI tests в `apps/web/src/__tests__`. **Modify:** только существующий rail selector, без переименования банковских provider IDs.

- [ ] RED auth/tenant/order validation, duplicate click/reload, expired quote, unsupported asset, network mismatch и forged wallet success. Invoice создаётся сервером, transaction payload строго из неё.
- [ ] Реализовать TON Connect connect/decline/return и серверный status polling; UI показывает сеть, asset, точную сумму, срок, fees и pending review. Wallet signature не зачисляет credits.
- [ ] Regression: RUB top-up/webhook/refund и gateway paid call по старому пути остаются рабочими; новый TON invoice после verified settlement даёт один доступный вызов и receipt.
- [ ] Проверить local browser desktop/mobile, keyboard/error recovery; профильные TS/React reviews. Mainnet option отключён config, новый AG origin/callback проверяется отдельно в существующем repo.

### Task AG-TON5: refund/unknown и evidence gate

**Create:** `packages/database/src/ton-refunds.ts`, native regression рядом с TON suite; `docs/product/acceptance/ton-testnet.md`, `docs/product/operations/ton-reconciliation.md`.
**Interfaces:** `requestTonRefund(invoiceId, amountAtomic, reason, idempotencyKey)` фиксирует исходный asset/approved recipient; `recordTonRefundSubmission(refundId, signedMessageIdentity)` предшествует broadcast; `reconcileTonRefund(refundId, chainEvidence)` завершает одну operation. Локальный signer = mock.

- [ ] RED/PASS: duplicate refund, refund>available, already-consumed credits, unknown broadcast, crash после network success, bounced refund. Unknown оставляет review и запрещает новый payment transfer; ledger reversal отдельно от успешной chain send.
- [ ] Сверить operator queue с invoices/chain/ledger totals, настроить deadline/alert ownership. Отработать recovery на локальных fixtures без key custody changes.
- [ ] Testnet gate: отдельная изолированная testnet identity и test assets, явная network verification, successful/failed/late transfer evidence, restart/replay и reconciliation. Если безопасного test signer/RPC нет, записать BLOCKED только этому live gate; fixture PASS не переименовывать testnet PASS.
- [ ] Release prerequisite: policy FX/fees/refund, merchant ownership, signer isolation, backup+external-chain reconcile, existing VPS artifact parity. No mainnet/funds/deploy здесь. x402 pilot возможен следующим отдельным планом и не блокирует native TON invoice.

## AG-TON1 — локальная приёмка 08.09.2026

Source `a5731d4`, ровно два pure shared файла. Независимое financial TS/spec review Approved;63/63 unit tests, strict shared type-check, focused ESLint и diff-check PASS. Exact parser имеет отдельную границу persist BIGINT; rational FX использует явные единицы, округление, fee и expiry. Промежуточное произведение ограничено signed BIGINT как консервативная v1 политика, даже если дальнейшее деление уменьшило бы число. Адреса только canonical raw testnet, без friendly-address SDK parsing. Default FX/цены/mainnet assets отсутствуют.

AG-TON2 invoice/ledger, AG-TON3 verifier/sweep и дальнейшие gates остаются открыты; не было DB settlement или live testnet/mainnet. Private evidence `.superpowers/sdd/2026-09-07-ton-payments/task-1-report.md`, immutable task-1.diff. Unit PASS не подтверждает работающий payment rail.
