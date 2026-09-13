# AG-TON3: trusted TON verifier and restartable recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Проверять входящие testnet TON/allowlisted jetton payments по полному server-side trace, сохранять наблюдения и восстанавливать sweep после сбоев, выдавая `VerifiedChainCredit` только через закрытую worker boundary.

**Architecture:** Первый срез — чистые bounded canonical evidence types и pure verifier на явно synthetic fixtures, без RPC, БД и runtime wiring. Затем отдельный evidence gate фиксирует точную схему TON Center v3 testnet и sanitized real provider fixtures; после него добавляются append-only observations, lease/cursor recovery, observe-only sweep и только после независимого review — internal settlement capability и выключенный по умолчанию startup.

**Tech Stack:** TypeScript, Bun 1.4.2, Vitest, PostgreSQL/`pg`, существующий `@aiag/shared/server` `safeFetch`, TON Center API v3 testnet как кандидат server-trusted indexer.

**Spec:** [родительский TON plan](2026-09-07-ton-payments.md), [принятый AG-TON2 invoice core](2026-09-08-ton-invoice-core.md), [официально grounded source boundary](../../research/2026-09-13-ton-verifier-source-boundary.md), [payment/evidence design](../../ecosystem/payment-and-evidence-design.md).

## Global Constraints

- Только `tvm:-3`; mainnet, production migration/deploy, push, новые keys/signers/funds, broadcast и платные provider calls не входят в этот план.
- `0072_ton_invoice_core.sql` и `packages/database/src/functions/ton-invoice-core.sql` неизменяемы. На design snapshot следующий свободный номер — `0073`; исполнитель обязан повторно прочитать manifest непосредственно перед созданием migration и взять фактический следующий свободный номер.
- Не повторять уже принятую TON2 приёмку `12 suites / 322 tests`, native `58 PASS` или clean migration72 только ради AG-TON3. Новая работа получает свои focused unit/native checks.
- Immutable invoice pins `verifierVersion` и `finalityPolicyId` не переопределяются текущей конфигурацией. Несовпадение ведёт в durable review, а не в fallback policy.
- Full trace, message linkage, inclusion anchor и finality/stability evidence обязательны. Missing, emulated, aborted, bounced или incomplete evidence не создаёт `VerifiedChainCredit`.
- RPC JSON, HTTP 200, TON Connect result, пользовательский BOC и поле indexer `finalized` сами по себе не дают credit.
- Synthetic JSON подписывается как `evidenceClass:'synthetic'`. Только захваченный у выбранного testnet provider и sanitized ответ может называться real provider fixture; live transfer остаётся отдельным testnet gate.
- До независимого financial/security review pure verifier, sanitized fixture manifest, recovery schema и import-boundary proof runtime settlement отсутствует. Нельзя включить его одним env-флагом раньше Task 6.
- SQL только prepared statements. RPC выполняется вне DB transaction/lease mutation. Логи содержат только invoice/source/trace IDs, result/reason и attempt count; headers, API keys, raw bodies, BOC и полные evidence snapshots не логируются.
- Не добавлять Web checkout/status route, TON Connect/login, refund, payout, новый product или Agents Market/Arena code.
- Не менять и не выводить новую acceptance из сохранённого `models.dev` commit `2fb0296`.

---

## Подтверждённая исходная база

- AG-TON2 принят локально на `c62ce98` + `724a031`; owner acceptance — `21bf66a`. Это не verifier/testnet/production acceptance.
- `packages/database/src/ton-payment-types.ts:67` определяет `VerifiedChainCredit`; `packages/database/src/ton-payments.ts:257` строго нормализует его и `:327` вызывает `aiag_settle_ton_invoice_v1`.
- `packages/database/src/index.ts:55-56` сейчас экспортирует TON types и `create/get/expire/settle`; list/observation/lease/cursor API отсутствуют.
- `apps/worker/src/index.ts:29` создаёт Redis для существующих workers. Старые crons на `:60-107` lazy-import database. TON startup/import-boundary tests отсутствуют.
- `packages/database/package.json` экспортирует только root и `./schema`; `tsup.config.ts` собирает только `src/index.ts` и `src/schema/index.ts`. Internal TON subpath придётся добавить явно.
- `packages/shared/src/safe-fetch.ts` уже даёт HTTPS-only, DNS/private/loopback/metadata guard, IP pinning и per-redirect revalidation. Для TON нельзя добавлять provider hostname в bypass `allowlist`; exact origin проверяется дополнительно, redirects запрещаются.

## Выбранная trust boundary и честное название

Для v1 выбран **server-trusted TON Center v3 testnet indexer boundary**, а не locally verified liteserver proof chain. Причина: v3 предоставляет нужные transaction/trace/masterchain данные и позволяет сделать маленький заменяемый adapter; REST v3 при этом не возвращает cryptographic proof bundles. Локальная proof-chain потребовала бы отдельного trust-anchor lifecycle, liteserver proof acquisition/validation и дополнительной реализации, которых в текущем repo и evidence нет.

Выбор остаётся **design candidate**, пока независимый review и sanitized real fixtures не подтвердят точный response manifest. В коде и evidence использовать значения:

```ts
export const TON_PROVIDER_ID = 'toncenter-v3-testnet' as const;
export const TON_PROVIDER_ORIGIN = 'https://testnet.toncenter.com' as const;
export const TON_EVIDENCE_MODEL = 'server_trusted_indexer' as const;
export const TON_VERIFIER_VERSION = 'aiag-toncenter-v3-verifier-v1' as const;
export const TON_FINALITY_POLICY_ID =
  'toncenter-v3-testnet-provider-attested-mc-depth-2-v1' as const;
```

`mc-depth-2` — консервативный operational stability threshold проекта, не утверждение о протокольной вероятности reorg. Credit возможен лишь когда provider сообщает complete trace с inclusion masterchain seqno `n`, latest indexed masterchain seqno `>= n + 2`, а transaction/trace/block anchors согласованы. Это provider-attested inclusion/finality; поле `last indexed block` не называется независимым proof.

Если real fixture показывает, что обязательное поле или stable LT pagination нельзя получить из выбранных v3 endpoints, Task 2 получает `BLOCKED_PROVIDER_MANIFEST`; нельзя удалить проверку, заменить proof флагом или перейти на другого provider внутри реализации. Новый provider либо locally verified liteserver chain требует отдельного architecture amendment и нового policy/version ID; старые invoices не переоцениваются.

## Замороженные domain contracts

```ts
export interface TonVerifierPolicy {
  network: 'tvm:-3';
  providerId: 'toncenter-v3-testnet';
  evidenceModel: 'server_trusted_indexer';
  verifierVersion: 'aiag-toncenter-v3-verifier-v1';
  finalityPolicyId: 'toncenter-v3-testnet-provider-attested-mc-depth-2-v1';
  minIndexedMasterchainDepth: 2;
  maxBundleBytes: 1_048_576;
  maxTraceTransactions: 128;
  maxMessagesPerTransaction: 64;
}

export type TonSourceErrorCode =
  | 'origin_mismatch' | 'redirect_rejected' | 'response_too_large'
  | 'http_unauthorized' | 'rate_limited' | 'timeout' | 'upstream_5xx'
  | 'provider_schema_invalid' | 'pagination_regressed';

export type TonObservedReason =
  | 'candidate_not_found' | 'trace_incomplete' | 'finality_pending';

export type TonReviewReason =
  | 'network_mismatch' | 'policy_mismatch' | 'trace_oversized'
  | 'trace_emulated' | 'trace_aborted' | 'trace_bounced' | 'trace_failed'
  | 'message_linkage_invalid' | 'inclusion_mismatch'
  | 'asset_mismatch' | 'recipient_mismatch' | 'sender_mismatch'
  | 'reference_mismatch' | 'amount_mismatch'
  | 'jetton_master_mismatch' | 'jetton_wallet_mismatch'
  | 'jetton_notification_invalid';

export type TonVerificationResult =
  | { kind: 'verified'; credit: VerifiedChainCredit; evidenceDigest: string }
  | { kind: 'observed'; reason: TonObservedReason; evidenceDigest: string | null }
  | { kind: 'review_required'; reason: TonReviewReason; evidenceDigest: string };

export type TonProviderResult =
  | { kind: 'page'; evidence: readonly NormalizedTonEvidence[];
      nextCursor: TonProviderCursor | null; exhausted: boolean }
  | { kind: 'source_error'; code: TonSourceErrorCode; retryAfterMs: number | null };

export interface TonProviderCursor {
  schemaVersion: 1;
  beforeLt: string | null;
  cycleUpperLt: string | null;
}

export interface TonSweepCursor {
  schemaVersion: 1;
  beforeLt: string | null;
  cycleUpperLt: string | null;
}

export interface TonReconciliationSource {
  sourceId:string;
  network:'tvm:-3';
  asset:TonInvoice['asset'];
  invoiceRecipient:string;
  scanFloorTimeMs:number;
}

export interface NormalizedTonMessage {
  hash: string;
  index: number;
  source: string | null;
  destination: string;
  bounced: boolean;
  opcode: string | null;
  amountAtomic: string;
  decodedPayload:
    | { kind:'native_comment'; reference:string }
    | { kind:'jetton_transfer'; amountAtomic:string; destination:string; forwardReference:string }
    | { kind:'jetton_internal_transfer'; amountAtomic:string; sender:string; responseDestination:string }
    | { kind:'jetton_notification'; amountAtomic:string; sender:string; forwardReference:string }
    | { kind:'other' };
}

export interface NormalizedTonTransaction {
  account: string;
  hash: string;
  lt: string;
  chainTimeMs: number;
  emulated: boolean;
  aborted: boolean;
  computeSuccess: boolean;
  actionSuccess: boolean;
  blockRef: {
    workchain: number; shard: string; seqno: number;
    rootHash: string; fileHash: string; masterchainSeqno: number;
  };
  inMessage: NormalizedTonMessage;
  outMessages: readonly NormalizedTonMessage[];
}

export interface NormalizedTonEvidence {
  schemaVersion: 1;
  source: {
    providerId:'toncenter-v3-testnet';
    origin:'https://testnet.toncenter.com';
    evidenceModel:'server_trusted_indexer';
    fetchedAtMs:number;
  };
  network: string;
  asset: TonInvoice['asset'];
  trace: {
    id:string; complete:boolean; masterchainSeqno:number;
    orderedTransactionHashes:readonly string[];
  };
  latestIndexedMasterchain: { seqno:number; rootHash:string; fileHash:string };
  transactions: readonly NormalizedTonTransaction[];
  creditPath:
    | { kind:'native'; recipientTransactionHash:string; creditMessageHash:string }
    | {
        kind:'jetton'; masterAddress:string; walletDerivationOwner:string;
        derivedMerchantWallet:string; transferMessageHash:string;
        internalTransferMessageHash:string; creditTransactionHash:string;
        notificationMessageHash:string;
      };
}

export type TonNormalizationFailure = {
  kind:'source_error';
  code:'response_too_large'|'provider_schema_invalid';
};

export interface TonEvidenceProvider {
  resolveRecipientAccount(
    source:TonReconciliationSource,
    signal:AbortSignal,
  ):Promise<{kind:'resolved';recipientAccount:string}|Extract<TonProviderResult,{kind:'source_error'}>>;
  scanAccountPage(
    recipientAccount:string,
    cursor:TonProviderCursor|null,
    signal:AbortSignal,
  ):Promise<TonProviderResult>;
}

export type TonObservationInput = {
  schemaVersion:1;
  invoiceId:string|null;
  sourceId:string;
  recipientAccount:string;
  eventIdentity:null|{txHash:string;messageHash:string;txLt:string};
  providerId:'toncenter-v3-testnet';
  evidenceModel:'server_trusted_indexer';
  result:
    | { kind:'source_error'; reason:TonSourceErrorCode; evidenceDigest:null }
    | { kind:'observed'; reason:TonObservedReason; evidenceDigest:string|null }
    | { kind:'unmatched'; reason:'invoice_reference_not_found'; evidenceDigest:string }
    | { kind:'verified_candidate'; reason:'verified_candidate'; evidenceDigest:string }
    | { kind:'review_required'; reason:TonReviewReason; evidenceDigest:string };
  providerCursor:TonProviderCursor|null;
  snapshot:Record<string,unknown>;
  observedAtMs:number;
};

export type TonObservationResult = {
  observationId:string;
  outcome:'inserted'|'already_recorded';
  invoiceStatus:TonInvoice['status'];
};
```

`NormalizedTonEvidence` содержит только bounded canonical facts: source manifest identity; trace ID/completeness; ordered transaction hashes/LTs/accounts; per-transaction `emulated/aborted/computeSuccess/actionSuccess`; ordered in/out message hashes, sources/destinations, bounced flags, opcodes, atomic values и decoded provider-trusted payload; transaction block ref; trace masterchain seqno; latest indexed masterchain anchor; optional jetton master `get_wallet_address(owner)` result. Raw provider response/BOC/API key в domain type и БД не входят.

Native acceptance требует exact inbound destination/amount/reference, optional expected sender, successful non-emulated recipient transaction, no bounced input/output and consistent message/transaction/trace anchors. Jetton acceptance дополнительно требует allowlisted invoice master/decimals, связный ordered path `transfer → internal_transfer → merchant wallet credit → transfer_notification`, opcode `0x7362d09c`, exact amount/sender/forward reference и provider-derived `get_wallet_address(invoice.recipient)` равный фактически credited merchant wallet. Один похожий notification либо ticker/metadata не проходит.

Reason precedence в pure verifier: `network/policy → bounds/emulated → abort/bounce/failure → trace/message/inclusion linkage → asset/recipient/sender/reference → amount → jetton master/wallet/notification → finality_pending → verified`. `trace_incomplete` остаётся observed/retry; deterministic contradictory evidence получает review. Source transport/schema failures не меняют invoice в review и идут в `source_error` observation/backoff.

## Frozen persistence and recovery contract

Следующая additive migration создаёт только два объекта состояния; существующие `ton_chain_events` остаются хранилищем только verified settlement evidence:

```sql
CREATE TABLE ton_chain_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID REFERENCES ton_invoices(id) ON DELETE RESTRICT,
  source_id VARCHAR(96) NOT NULL,
  recipient_account VARCHAR(67) NOT NULL,
  tx_hash CHAR(64),
  message_hash CHAR(64),
  tx_lt VARCHAR(78),
  provider_id VARCHAR(96) NOT NULL,
  evidence_model TEXT NOT NULL CHECK (evidence_model='server_trusted_indexer'),
  result_kind TEXT NOT NULL CHECK
    (result_kind IN ('source_error','observed','unmatched','verified_candidate','review_required')),
  reason VARCHAR(64) NOT NULL,
  observation_key CHAR(64) NOT NULL UNIQUE,
  evidence_digest CHAR(64),
  provider_cursor JSONB,
  snapshot JSONB NOT NULL CHECK
    (jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=32768),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (observation_key ~ '\A[0-9a-f]{64}\Z'),
  CHECK ((tx_hash IS NULL AND message_hash IS NULL AND tx_lt IS NULL)
      OR (tx_hash ~ '\A[0-9a-f]{64}\Z'
      AND message_hash ~ '\A[0-9a-f]{64}\Z'
      AND tx_lt ~ '\A(0|[1-9][0-9]{0,77})\Z'))
);

CREATE TABLE ton_reconciliation_cursors (
  source_id VARCHAR(96) PRIMARY KEY,
  schema_version SMALLINT NOT NULL CHECK (schema_version=1),
  network TEXT NOT NULL CHECK (network='tvm:-3'),
  provider_id VARCHAR(96) NOT NULL,
  cursor JSONB,
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures>=0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_error_code VARCHAR(64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((lease_owner IS NULL)=(lease_expires_at IS NULL))
);
```

`ton_chain_observations` получает immutable UPDATE/DELETE trigger. `observation_key` — SHA-256 stable JSON от invoiceId/null, sourceId, recipientAccount, event identity, result kind/reason/evidence digest, provider cursor и sanitized snapshot; `observedAtMs` исключён, поэтому crash replay возвращает persisted ID. `verified_candidate` сначала переводит `pending→observed` guarded CAS; `review_required` переводит `pending|observed|expired→review_required` и не переписывает terminal reason. `source_error`, `candidate_not_found` и `unmatched` invoice status не меняют. Все functions — `SECURITY INVOKER`, exact `search_path`, `REVOKE EXECUTE ... FROM PUBLIC`; новые production role grants не изобретаются.

Для observation с non-null invoice SQL сначала читает org hint без lock, затем соблюдает TON2 порядок `organization FOR UPDATE → invoice FOR UPDATE`, повторно сверяет invoice/source network+asset+recipient и exact reference из snapshot. Только после этого вставляет observation и делает допустимый status CAS; race с settlement не может вернуть terminal invoice в observed/review. Для `unmatched` invoice ID обязан быть null, status mutation отсутствует, а unique observation key строится без invoice ID.

Discovery выполняется по chain credit account, не отдельно для каждой invoice. Native source сканирует immutable invoice recipient; jetton source сначала получает provider-derived wallet для пары `(allowlisted master, invoice recipient owner)`, затем сканирует этот merchant jetton wallet. Source ID детерминирован из provider/network/asset/owner и не зависит от ответа provider. Exact decoded reference связывается с глобально unique `ton_invoices.reference`; неизвестная/неправильная reference сохраняется один раз как `unmatched` с `invoice_id=NULL` и никогда не переводит случайную invoice в review. После exact reference binding pure verifier проверяет остальные invoice facts, включая совпадение derived/factually credited jetton wallet.

Database root экспортирует только `createTonInvoice`, `getTonInvoice`, `expireTonInvoice` и public types. Worker capability находится только в explicit subpath `@aiag/database/ton-reconciliation-internal`:

```ts
export interface CloseableTonWorkerDatabase extends TonPaymentDatabase {
  close(): Promise<void>;
}
export function createTonWorkerDatabase(connectionString: string): CloseableTonWorkerDatabase;
export function claimTonReconciliationLease(db: TonPaymentDatabase, input: {
  sourceId: string; leaseOwner: string; leaseMs: 90_000;
}): Promise<{ kind:'claimed'; cursor:TonSweepCursor|null } | { kind:'busy' }>;
export function listTonReconciliationSources(db: TonPaymentDatabase, input: {
  afterSourceId:string|null; limit:number;
}): Promise<readonly TonReconciliationSource[]>;
export function findTonInvoicesForReconciliation(db: TonPaymentDatabase, input: {
  source:TonReconciliationSource; references:readonly string[];
}): Promise<readonly TonInvoice[]>;
export function getTonInvoiceForReconciliation(db: TonPaymentDatabase,
  invoiceId:string): Promise<TonInvoice|null>;
export function recordTonChainObservation(db: TonPaymentDatabase,
  input: TonObservationInput): Promise<TonObservationResult>;
export function advanceTonReconciliationCursor(db: TonPaymentDatabase, input: {
  sourceId:string; leaseOwner:string; expected:TonSweepCursor|null;
  next:TonSweepCursor|null; outcome:'success'|'source_error';
  nextAttemptAtMs:number; errorCode:TonSourceErrorCode|null;
}): Promise<'advanced'|'lease_lost'|'cursor_conflict'>;
export function releaseTonReconciliationLease(db: TonPaymentDatabase,
  sourceId:string, leaseOwner:string): Promise<'released'|'lease_lost'>;
```

Task 3 создаёт этот subpath только с observation/recovery APIs. Task 5 атомарно удаляет `settleTonInvoice` из root export и добавляет его в этот explicit internal subpath после import-boundary RED; до этого не должно быть двух settlement entrypoints.

`limit` допускает integer `1..16`. Source list выводит distinct `(network,asset,invoice recipient)` из immutable invoices, добавляет `scanFloorTimeMs=min(quoted_at)` и сортируется по `sourceId=sha256(providerId+'\0'+stableAssetJson+'\0'+recipient)`. Provider scan идёт newest→older по resolved credit-account LT с inclusive one-item overlap, максимум четыре страницы по восемь transactions на source за run и не идёт старше `scanFloorTimeMs`. `cycleUpperLt` фиксирует первый LT цикла: новые transactions выше него будут прочитаны в следующем цикле, а не потеряны посреди descending pagination. На empty page или достижении floor cursor сбрасывается в `null`, поэтому следующий cycle намеренно пересканирует bounded history и увидит поздно проиндексированный transfer; duplicates удаляются по `(account,txHash,messageHash)`. Это консервативный testnet v1 tradeoff; оптимизация high-water/retention требует отдельной policy и не может вводиться скрыто.

Lease не держит SQL transaction во время RPC. После каждой полностью обработанной provider page runner renew/advance делает compare-and-set по `sourceId+leaseOwner+expected cursor`; loss останавливает текущий run. Backoff: timeout/5xx — `min(5_000 * 2^(failures-1), 900_000)` ms; `Retry-After` для 429 clamp `1_000..900_000`; successful bounded run сбрасывает failures. Cursor двигается только после durable observations всей page и, в settle mode, после settlement result/ACK каждого связанного candidate.

## Task 1: первый implementable slice — pure evidence verifier

**Files:**
- Create: `apps/worker/src/ton-payment-evidence.ts`
- Create: `apps/worker/src/ton-payment-verifier.ts`
- Create: `apps/worker/src/__tests__/ton-payment-verifier.test.ts`
- Create: `apps/worker/src/__fixtures__/ton/synthetic-native-success.json`
- Create: `apps/worker/src/__fixtures__/ton/synthetic-jetton-success.json`
- Modify: `apps/worker/package.json` only if a focused test script is needed; no TON SDK dependency in this task.

**Interfaces:**
- Consumes: `TonInvoice`, `VerifiedChainCredit` type only from `@aiag/database`; no database value import.
- Produces: `normalizeCanonicalTonEvidence(input:unknown,limits): NormalizedTonEvidence | TonNormalizationFailure`; `verifyChainCredit(invoice,evidence,policy): TonVerificationResult`.

- [ ] **Step 1: write RED bounds/identity tests.** Use the exact constants and unions above. Assert outer serialized fixture `<=1_048_576` bytes, transactions `<=128`, messages per transaction `<=64`, hashes lowercase64, addresses canonical raw, LT/amount canonical decimal≤78, timestamps safe integers, exact known keys after normalization. Oversized input returns `{kind:'source_error',code:'response_too_large'}` before array mapping/hash work.

```ts
it('never promotes missing full-path or provider-attested finality', () => {
  expect(verify(invoice, patch(native, { traceComplete:false })))
    .toMatchObject({ kind:'observed', reason:'trace_incomplete' });
  expect(verify(invoice, patch(native, { latestIndexedMcSeqno:native.traceMcSeqno+1 })))
    .toMatchObject({ kind:'observed', reason:'finality_pending' });
  expect(verify(invoice, patch(native, { transaction:{ emulated:true } })))
    .toMatchObject({ kind:'review_required', reason:'trace_emulated' });
});
```

- [ ] **Step 2: run RED.** Run `bunx vitest run apps/worker/src/__tests__/ton-payment-verifier.test.ts`; expected failure is missing modules/exports, not fixture parse failure.
- [ ] **Step 3: implement the minimal pure normalizer and verifier.** No `fetch`, env, timers, logger, DB imports or settlement call. Canonicalize once, SHA-256 the stable normalized evidence for `executionPathDigest/evidenceDigest`, and construct `VerifiedChainCredit` only in the `verified` branch with invoice pins copied exactly.
- [ ] **Step 4: add the complete adversarial matrix.** Synthetic cases: wrong network/recipient/reference/amount/decimals/sender, fake jetton master, notification-only path, wrong derived wallet, wrong opcode, broken message hash link, duplicate/reordered path, aborted/compute/action failure, bounced input/output, incomplete/emulated trace, inconsistent block/mc anchors, missing depth and arrays at bound/bound+1. Every fixture metadata says `evidenceClass:'synthetic'` and `realProvider:false`.
- [ ] **Step 5: run PASS and static boundary checks.** Run focused Vitest and `bun run --filter @aiag/worker type-check`. `rg -n "fetch\(|settleTonInvoice|DATABASE_URL|setInterval" apps/worker/src/ton-payment-{evidence,verifier}.ts` must return no matches.
- [ ] **Step 6: review/commit.** Independent TS/security review must confirm pure boundary, reason precedence and no proof claim. Commit only these files with `feat(worker): add pure TON evidence verifier`.

**Gate 1 result:** test code may produce a `VerifiedChainCredit` from synthetic normalized evidence, but no runtime module can import a settlement capability and no claim of real provider/testnet verification is allowed.

## Task 2: exact TON Center v3 manifest, bounded adapter and sanitized real fixtures

**Files:**
- Create: `apps/worker/src/ton-payment-provider.ts`
- Create: `apps/worker/src/__tests__/ton-payment-provider.test.ts`
- Create: `apps/worker/src/__fixtures__/ton/toncenter-v3-testnet/manifest.json`
- Create after authorized read-only capture: `apps/worker/src/__fixtures__/ton/toncenter-v3-testnet/native-success.sanitized.json`
- Create after authorized read-only capture: `apps/worker/src/__fixtures__/ton/toncenter-v3-testnet/native-aborted.sanitized.json`
- Create after authorized read-only capture: `apps/worker/src/__fixtures__/ton/toncenter-v3-testnet/native-bounced.sanitized.json`
- Create after authorized read-only capture: `apps/worker/src/__fixtures__/ton/toncenter-v3-testnet/jetton-success.sanitized.json`
- Modify: `apps/worker/src/ton-payment-evidence.ts` only for field mapping proven by the manifest.

**Interfaces:**
- Consumes: chosen constants, `safeFetch` from `@aiag/shared/server`, injected `fetchImpl` in tests.
- Produces: `createToncenterV3Provider(config): TonEvidenceProvider`; `resolveRecipientAccount(source,signal)` and `scanAccountPage(recipientAccount,cursor,signal): Promise<TonProviderResult>`.

- [ ] **Step 1: freeze the response manifest before mapping code.** Record exact endpoint paths/query parameters, request order, required fields/types, nullability, pagination direction, content types and fixture SHA-256. At minimum cover transactions by recipient account/time/LT, trace by tx/message hash, masterchain info and jetton master wallet derivation. Store no Authorization header/query secret and no unsanitized raw BOC.
- [ ] **Step 2: enforce evidence labels.** Real files contain `evidenceClass:'sanitized_real_provider_response'`, `providerId`, exact origin, network, `capturedAt`, endpoint path, redactions list and sanitized body. Synthetic files cannot be placed in this directory. A test rejects `evidenceClass:'synthetic'` when loading the real-fixture suite.
- [ ] **Step 3: write RED transport tests.** Cover native recipient passthrough, jetton master+owner wallet resolution, non-exact origin, username/password URL, http, port/path/query origin tricks, localhost/127/IPv6/private/link-local/metadata resolution, redirects, oversized/missing `Content-Length`, body crossing 1 MiB while streaming, non-JSON, 401/403, 429 with bounded Retry-After, timeout and 5xx. No test makes a real network call.
- [ ] **Step 4: implement bounded adapter.** Accept only exact `new URL(baseUrl).href === 'https://testnet.toncenter.com/'` and empty username/password; fixed `/api/v3/...` endpoint paths are code constants. Call `safeFetch` with no bypass allowlist and `maxRedirects:0`; abort each call after 8 seconds; reject on header or streamed byte count above 1 MiB before `JSON.parse`. Build queries only with `URLSearchParams` from canonical invoice/cursor fields.
- [ ] **Step 5: map real fixture fields into canonical evidence.** Unknown provider fields may be ignored after total-size bounds, but every required field is type/range checked and missing/null fails closed. Provider `finalized`/`mc_seqno` flags are source facts only; verifier still checks complete trace, cross-links, inclusion anchors and indexed-head depth.
- [ ] **Step 6: verify pagination.** Account pages are descending LT, eight rows; next `beforeLt` overlaps the final row and preserves the first-page `cycleUpperLt`. Test new rows inserted between page calls, inclusive duplicate, empty page, repeated cursor and LT regression. Repeated/regressed cursor returns `pagination_regressed`, never silently skips.
- [ ] **Step 7: focused PASS/review/commit.** Run provider+verifier Vitest, worker type-check and focused lint. Independent review must compare mapping with checked-in sanitized fixtures and official source links. Commit `feat(worker): normalize bounded TON Center evidence`.

**Gate 2 result:** without at least one sanitized complete native success and one aborted/bounced failure from the real provider, this task is `BLOCKED_PROVIDER_FIXTURES`; generated example payloads do not satisfy it. Jetton auto-credit remains disabled until a sanitized complete jetton path and wallet-derivation fixture exists. A public historical trace may satisfy the provider-fixture gate; it does not satisfy live merchant testnet payment acceptance.

## Task 3: append-only observations and durable lease/cursor

**Files:**
- Create: `packages/database/migrations/0073_ton_reconciliation.sql` after recheck; if `0073` is occupied, update this plan to the actual next ID before implementation and review that plan-only change.
- Modify: `packages/database/src/schema/ton-payments.ts`
- Modify: `packages/database/src/ton-payment-types.ts`
- Modify: `packages/database/src/ton-payments.ts`
- Create: `packages/database/src/ton-reconciliation-internal.ts`
- Modify: `packages/database/tsup.config.ts`
- Modify: `packages/database/package.json`
- Create: `packages/database/src/__tests__/ton-reconciliation.test.ts`
- Create: `packages/database/scripts/__tests__/ton-reconciliation.native.integration.test.ts`

**Interfaces:**
- Consumes: persistence contract above; accepted TON2 `TonPaymentDatabase` and invoice JSON projection.
- Produces: explicit internal subpath APIs above. `settleTonInvoice` moves off the root export in Task 5, not yet in this task.

- [ ] **Step 1: recheck migration manifest.** Run `find packages/database/migrations -maxdepth 1 -type f -printf '%f\n' | sort | tail`; select next unused numeric ID. If another worker owns it, increment; never rename/rewrite an applied migration.
- [ ] **Step 2: write RED wrapper/schema tests.** Test strict cursor/observation key sets, canonical UUID/address/hash/LT/time, limits before serialization and prepared `{text,values}` queries. Reject `limit=0|17`, forged result kind/reason pairing, non-null invoice on `unmatched`, missing event identity on candidate results and snapshot>32768 bytes before SQL.
- [ ] **Step 3: write RED native concurrency/restart tests on an owned disposable loopback DB.** Two lease owners race: exactly one claims. Cover expired lease takeover, stale owner advance/release, expected-cursor CAS, cursor null wrap, deterministic source listing, LT overlap/no gap, exact unique reference binding across pending/observed/expired/settled/review invoices, unknown reference→one nullable-invoice observation, duplicate observation ID, immutable UPDATE/DELETE and allowed status transitions.
- [ ] **Step 4: implement additive migration/functions.** Use the exact two-table schema above, a source-scan index on `ton_invoices(network,asset_kind,master_address,asset_decimals,recipient,created_at,id)` and observation index `(invoice_id,created_at,id)`, immutable trigger and prepared SQL functions. Observation insert+invoice status CAS is one transaction; lease/advance uses `UPDATE ... WHERE lease_owner=$n AND cursor IS NOT DISTINCT FROM $n RETURNING`. Function validation enforces the exact result-kind/reason unions and nullable invoice/event rules before casts.
- [ ] **Step 5: create closeable native DB adapter.** `createTonWorkerDatabase` uses one `pg.Pool`; every `transaction` checks out one client and runs BEGIN/COMMIT/ROLLBACK; `close()` ends the pool. Neon HTTP is rejected for this callback transaction boundary. Tests inject a fake pool; credentials are never logged.
- [ ] **Step 6: add the explicit package entry.** Add `src/ton-reconciliation-internal.ts` to tsup entries and `./ton-reconciliation-internal` to package exports. Do not export it from `src/index.ts`.
- [ ] **Step 7: run focused verification.** Run database wrapper tests, the new guarded native suite, database type-check and worker type-check. Do not invoke the old 322/native58/clean72 acceptance commands. Independent SQL/security review checks ACL, immutability, lock/CAS ordering and disposable DB cleanup.
- [ ] **Step 8: commit.** Commit `feat(database): persist TON reconciliation recovery` with the actual migration number in the report.

## Task 4: observe-only restartable reconciler

**Files:**
- Create: `apps/worker/src/ton-payment-reconciler.ts`
- Create: `apps/worker/src/__tests__/ton-payment-reconciler.test.ts`
- Create: `apps/worker/src/ton-payment-bootstrap.ts`
- Create: `apps/worker/src/__tests__/ton-payment-bootstrap.test.ts`
- Do not modify: `apps/worker/src/index.ts` in this task.

**Interfaces:**
- Consumes: provider, verifier and internal observation/lease/list/cursor APIs. Settlement dependency is deliberately absent.
- Produces: `reconcileTonInvoice(...)`; `reconcileTonInvoices({cursor,limit},deps): Promise<{nextCursor,processed}>`; `startTonObservationFromEnv(deps): Promise<{close():Promise<void>}>` supporting only `disabled|observe`.

```ts
export interface TonObserveReconcilerDeps {
  getInvoice(invoiceId:string):Promise<TonInvoice|null>;
  listSources(input:{afterSourceId:string|null;limit:number}):
    Promise<readonly TonReconciliationSource[]>;
  findInvoices(input:{source:TonReconciliationSource;
    references:readonly string[]}):Promise<readonly TonInvoice[]>;
  provider:TonEvidenceProvider;
  recordObservation(input:TonObservationInput):Promise<TonObservationResult>;
  nowMs():number;
}
export type TonReconcileItemResult =
  | { kind:'not_found' }
  | { kind:'source_error'; code:TonSourceErrorCode }
  | { kind:'unmatched'; evidenceDigest:string }
  | { kind:'observed'; reason:TonObservedReason }
  | { kind:'review_required'; reason:TonReviewReason }
  | { kind:'verified_candidate'; credit:VerifiedChainCredit };
export function reconcileTonInvoice(
  input:{invoiceId:string;cursor:TonSweepCursor|null;limit:number;signal:AbortSignal},
  deps:TonObserveReconcilerDeps,
):Promise<TonReconcileItemResult>;
export function reconcileTonInvoices(
  input:{source:TonReconciliationSource;cursor:TonSweepCursor|null;
    limit:number;signal:AbortSignal},
  deps:TonObserveReconcilerDeps,
):Promise<{nextCursor:TonSweepCursor|null;processed:number}>;
```

- [ ] **Step 1: write RED orchestration tests.** Assert durable sequence `list sources → claim source → resolve native/jetton credit account → scan account outside transaction → exact-reference lookup → verify/unmatched → observation → advance`. Inject crash after provider, after observation and before/after cursor ACK; restart with a new reconciler uses persisted cursor/observation, does not lose a transfer and deduplicates replay.
- [ ] **Step 2: cover result behavior.** Empty page/`candidate_not_found`, `trace_incomplete` and `finality_pending` remain retryable; deterministic verifier rejection records review; unknown reference records one `unmatched` observation with no invoice transition; source errors record no raw body and apply exact backoff. Out-of-order evidence, rows inserted above `cycleUpperLt`, page boundary overlap, end-of-cycle null wrap and signal abort preserve the last durable cursor.
- [ ] **Step 3: cover concurrency.** Two runners with different lease UUIDs process one source; only claimant calls provider. Lease loss after a provider response permits observation dedup but forbids cursor advance. No SQL transaction remains open while provider promise is pending.
- [ ] **Step 4: implement observe-only reconciler.** `verified` produces `verified_candidate` observation only. No settlement function/dependency/import exists. Cap one source run at four provider pages of eight candidates and renew/check the 90-second lease after each page.
- [ ] **Step 5: implement fail-closed bootstrap.** Unset/`disabled` returns a no-op handle before provider/DB factories. `observe` requires exact policy/version/source/origin and `DATABASE_URL`; unknown mode, including `settle`, throws before factories. Timer is unref'd, does not overlap its previous run, and `close()` aborts in-flight work, clears timer, releases lease and closes DB.
- [ ] **Step 6: run PASS/review/commit.** Run reconciler/bootstrap/provider/verifier tests and worker type-check/lint. Assert disabled config makes zero TON provider, DB, timer and dynamic internal-package factory calls; existing Redis behavior is outside this assertion. Commit `feat(worker): add observe-only TON recovery sweep`.

## Task 5: settlement import boundary and crash-safe internal caller

**Files:**
- Modify: `packages/database/src/index.ts`
- Modify: `packages/database/src/ton-reconciliation-internal.ts`
- Modify: `packages/database/src/__tests__/ton-payments.test.ts`
- Modify: TON native fixture imports only where required to preserve accepted coverage.
- Modify: `apps/worker/src/ton-payment-reconciler.ts`
- Modify: `apps/worker/src/ton-payment-bootstrap.ts`
- Create: `apps/worker/src/__tests__/ton-payment-import-boundary.test.ts`
- Modify: `apps/worker/src/__tests__/ton-payment-reconciler.test.ts`
- Keep `apps/worker/src/index.ts` unchanged.

**Interfaces:**
- Consumes: pure `verified` result and explicit `settleVerifiedCredit(invoiceId,credit)` dependency supplied only by bootstrap.
- Produces: internal settlement path; runtime bootstrap still supports only `disabled|observe` until Gate 5 acceptance.

- [ ] **Step 1: write RED import-boundary test.** Assert root `@aiag/database` declaration/export has no value export named `settleTonInvoice`. Its definition may remain in `packages/database/src/ton-payments.ts`; only `packages/database/src/ton-reconciliation-internal.ts` may re-export it, package tests/native fixtures may import it for accepted coverage, and only `apps/worker/src/ton-payment-bootstrap.ts` may consume the internal package subpath at runtime. Assert `apps/web` and `packages/api-gateway` contain neither internal subpath import nor `aiag_settle_ton_invoice_v1`.

```ts
expect(databaseRoot).not.toMatch(/settleTonInvoice/);
expect(forbiddenRuntimeFiles).toEqual([]);
expect(workerInternalImporters).toEqual(['apps/worker/src/ton-payment-bootstrap.ts']);
```

- [ ] **Step 2: move root capability.** Remove only `settleTonInvoice` from `packages/database/src/index.ts`; preserve its type contracts. Export the value only from the explicit internal subpath. Update database tests/native fixtures to import that explicit source/subpath without weakening TON2 assertions.
- [ ] **Step 3: inject settlement into reconciler.** In `mode:'settle'` path, call only after `result.kind==='verified'` and durable `verified_candidate` observation. `observed`, `review_required` and `source_error` cannot reach the dependency by type switch and tests.
- [ ] **Step 4: test crash/concurrency semantics.** Crash before settlement leaves no grant and cursor unchanged; crash after DB commit/before ACK retries and receives `already_settled`; concurrent on-demand/sweep candidates produce one TON event/receipt/grant through accepted TON2 DB guards. Evidence conflict/review does not advance as success until durable result is recorded.
- [ ] **Step 5: prove no forgery seam.** Tests pass malformed/fake user JSON, HTTP-style `{verified:true}`, raw BOC and provider `finalized:true`; none type-normalize into `VerifiedChainCredit` or call settlement. Future API may pass only `invoiceId` to `reconcileTonInvoice`; no HTTP handler receives credit/evidence.
- [ ] **Step 6: focused PASS and two reviews.** Run database TON wrapper tests, worker verifier/reconciler/import-boundary tests, new native reconciliation suite and both package type-checks/lint. Require independent financial/security review of grant reachability and separate TS review of imports/restart behavior.
- [ ] **Step 7: commit.** Commit `refactor(ton): isolate verified settlement capability`.

**Gate 5 result:** source can settle only through the reviewed worker injection seam, but deployed/default runtime remains incapable because startup has no `settle` mode and `index.ts` is not wired.

## Task 6: controlled disabled-by-default startup

**Files:**
- Modify: `apps/worker/src/ton-payment-bootstrap.ts`
- Modify: `apps/worker/src/__tests__/ton-payment-bootstrap.test.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/__tests__/ton-payment-import-boundary.test.ts`
- Create: `docs/product/acceptance/ton-verifier-testnet.md`

**Interfaces:**
- Consumes: accepted Gate 5 source/reviews and exact provider/policy constants.
- Produces: `startTonReconciliationFromEnv()` with `disabled|observe|settle`; worker graceful-close handle.

- [ ] **Step 1: hard prerequisite check.** Do not start this task unless Tasks 1-5 commits, sanitized provider fixtures, fresh focused/native results, independent financial/security + TS reviews and import-boundary test are all recorded. Otherwise report `BLOCKED_RUNTIME_SETTLEMENT` and stop without editing startup.
- [ ] **Step 2: write RED startup tests.** Unset/`disabled` performs zero TON DB/provider/timer calls. Unknown mode fails closed. `observe` cannot receive settlement dependency. `settle` requires exact provider origin/network/policy/version/source ID and database URL before constructing resources; mismatch fails before network/DB. `close()` aborts, waits boundedly, releases lease and closes pool once.
- [ ] **Step 3: add settle mode behind exact config.** The bootstrap dynamically imports `@aiag/database/ton-reconciliation-internal` only after validation. No default API key is invented; an optional existing secret is passed only as a header and never logged/persisted. Default remains `disabled`.
- [ ] **Step 4: wire index minimally.** After `loadSharedEnv()`, create one TON handle through the bootstrap and include its `close()` in existing graceful shutdown. Do not reuse Redis/BullMQ for the TON cursor and do not change old cron behavior. If TON startup fails in enabled mode, worker fails closed and closes already-created TON resources.
- [ ] **Step 5: prove controlled behavior.** Run worker bootstrap/import-boundary/reconciler/provider/verifier tests plus worker type-check/lint. A source-level test confirms `index.ts` has one TON bootstrap call and no direct provider/DB/settlement import. Disabled test distinguishes “zero TON calls” from the worker's existing Redis/network behavior.
- [ ] **Step 6: run observe-only real-provider evidence check.** With explicit authorization and no signer/funds, run one bounded read-only testnet provider observation against the pinned origin; save only sanitized request manifest/result/check time. It may validate retrieval and restart, not payment ownership or live transfer.
- [ ] **Step 7: preserve the live testnet gate.** The acceptance document must list successful/aborted/bounced/late native and jetton transfer evidence, restart/replay and one-credit conservation as unverified until an isolated signer/test assets/funds are separately authorized. Synthetic and historical provider fixtures cannot mark these PASS. Mainnet and production remain blocked.
- [ ] **Step 8: final review/commit.** Independent review confirms default disabled, exact pinning, loopback/redirect guard, cleanup and no Web/API route. Commit `feat(worker): gate TON reconciliation startup`.

## Verification matrix and stop conditions

| Evidence | What it can prove | What it cannot prove |
|---|---|---|
| Synthetic unit fixtures | Bounds, reason precedence, full-path rules, pure determinism | Actual provider field availability or chain event |
| Sanitized real provider fixtures | Exact v3 mapping and observed success/failure shapes | Live merchant transfer, independent cryptographic proof, runtime deployment |
| Mock-provider + disposable DB | Lease/cursor restart, dedup, crash and concurrency behavior | Public testnet availability or credentials |
| Authorized read-only provider run | Current endpoint/origin/pagination behavior | Payment ownership, signer behavior or money conservation |
| Authorized live testnet transfers | End-to-end testnet verifier/settlement/replay for captured scenarios | Mainnet, production role grants/deploy or legal/financial release readiness |

Stop without weakening policy when any of these occurs:

- response manifest lacks complete trace, message linkage, block ref, trace masterchain seqno or stable indexed-head data;
- jetton fixture cannot prove master→merchant wallet derivation and full credit path;
- stable LT pagination cannot be demonstrated without gaps;
- root/public import still exposes settlement, Web/API can import the internal subpath, or disabled mode constructs TON DB/provider resources;
- migration number is occupied, checksum differs, disposable DB identity/cleanup is not proven, or concurrent lease/cursor tests fail;
- evidence pins differ from immutable invoice, or a test only passes by calling `settleTonInvoice` with handcrafted credit outside the worker seam.

No stop condition authorizes a fallback to indexer flags, client wallet success, raw JSON/BOC, a different provider, mainnet, or a looser historical invoice policy.
