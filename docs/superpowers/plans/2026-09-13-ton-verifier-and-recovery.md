# AG-TON3: trusted TON verifier and restartable recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Проверять входящие testnet TON/allowlisted jetton payments по полному server-side trace, сохранять наблюдения и восстанавливать sweep после сбоев, создавая `VerifiedChainCredit` в проверенном worker call path; runtime settlement требует отдельного DB authorization gate.

**Architecture:** Первый срез — чистые bounded canonical evidence types и pure verifier на явно synthetic fixtures, без RPC, БД и runtime wiring. Затем отдельный evidence gate фиксирует точную схему TON Center v3 testnet и sanitized real provider fixtures; после него добавляются append-only observations, lease/cursor recovery, observe-only sweep и только после независимого review — internal settlement call path в fixtures и выключенный по умолчанию observe-only startup. Settlement activation остаётся отдельным gate с доказанными worker-only DB правами.

**Tech Stack:** TypeScript, Bun 1.4.2, Vitest, PostgreSQL/`pg`, существующий `@aiag/shared/server` `safeFetch`, TON Center API v3 testnet как кандидат server-trusted indexer.

**Spec:** [родительский TON plan](2026-09-07-ton-payments.md), [принятый AG-TON2 invoice core](2026-09-08-ton-invoice-core.md), [официально grounded source boundary](../../research/2026-09-13-ton-verifier-source-boundary.md), [payment/evidence design](../../ecosystem/payment-and-evidence-design.md).

## Global Constraints

- Только `tvm:-3`; mainnet, production migration/deploy, push, новые keys/signers/funds, broadcast и платные provider calls не входят в этот план.
- `0072_ton_invoice_core.sql` и `packages/database/src/functions/ton-invoice-core.sql` неизменяемы. Catalog Task 2 эксклюзивно владеет `0073_gateway_catalog_revision.sql`, независимо от того, отсутствует ли файл, находится в WIP или уже принят; TON reconciliation получает ожидаемый номер `0074_ton_reconciliation.sql`. Исполнитель TON обязан непосредственно перед созданием migration повторно прочитать manifest и controller ownership ledger. Если `0074` уже занят, он останавливается для ещё одной plan-only поправки и независимого review; переименовывать существующую или применённую migration нельзя.
- Не повторять уже принятую TON2 приёмку `12 suites / 322 tests`, native `58 PASS` или clean migration72 только ради AG-TON3. Новая работа получает свои focused unit/native checks.
- Immutable invoice pins `verifierVersion` и `finalityPolicyId` не переопределяются текущей конфигурацией. Несовпадение ведёт в durable review, а не в fallback policy.
- Full trace, message linkage, inclusion anchor и finality/stability evidence обязательны. Missing, emulated, aborted, bounced или incomplete evidence не создаёт `VerifiedChainCredit`.
- RPC JSON, HTTP 200, TON Connect result, пользовательский BOC и поле indexer `finalized` сами по себе не дают credit.
- Synthetic JSON подписывается как `evidenceClass:'synthetic'`. Только захваченный у выбранного testnet provider и sanitized ответ может называться real provider fixture; live transfer остаётся отдельным testnet gate.
- До независимого financial/security review pure verifier, sanitized fixture manifest, recovery schema и import-boundary proof runtime settlement отсутствует. Tasks1–6 не разрешают runtime settlement; одного env-флага недостаточно и после Task6 без отдельного DB authorization gate.
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
  | 'provider_schema_invalid' | 'pagination_regressed' | 'recipient_binding_changed'
  | 'unsupported_asset';

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

export type TonSettlementObservationReason = 'settlement_evidence_conflict';

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
  beforeLt: string;
  beforeTransactionHash: string;
  cycleUpperLt: string;
}

export interface TonSweepCursor {
  schemaVersion: 1;
  beforeLt: string;
  beforeTransactionHash: string;
  cycleUpperLt: string;
}

export type TonRecipientBinding = {
  recipientAccount:string;
  derivation:
    | {kind:'native';ownerAddress:string}
    | {kind:'jetton';masterAddress:string;ownerAddress:string;walletAddress:string};
};

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
    | { kind:'review_required';
        reason:TonReviewReason|TonSettlementObservationReason;
        evidenceDigest:string };
  providerCursor:TonProviderCursor|null;
  snapshot:Record<string,unknown>;
  observedAtMs:number;
};

export type TonObservationResult = {
  observationId:string;
  outcome:'inserted'|'already_recorded';
  invoiceStatus:TonInvoice['status']|null;
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
  recipient_account VARCHAR(67),
  recipient_binding JSONB,
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures>=0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_error_code VARCHAR(64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((lease_owner IS NULL)=(lease_expires_at IS NULL)),
  CHECK ((recipient_account IS NULL)=(recipient_binding IS NULL)),
  CHECK (recipient_binding IS NULL OR (jsonb_typeof(recipient_binding)='object'
    AND octet_length(recipient_binding::text)<=2048))
);
```

`ton_chain_observations` получает immutable UPDATE/DELETE trigger. `observation_key` — SHA-256 stable JSON от invoiceId/null, sourceId, recipientAccount, event identity, result kind/reason/evidence digest, provider cursor и sanitized snapshot; `observedAtMs` исключён, поэтому crash replay возвращает persisted ID. `verified_candidate` сначала переводит `pending→observed` guarded CAS; `review_required` переводит `pending|observed|expired→review_required` и не переписывает terminal reason. `source_error`, `candidate_not_found` и `unmatched` invoice status не меняют. Все functions — `SECURITY INVOKER`, exact `search_path`, `REVOKE EXECUTE ... FROM PUBLIC`; новые production role grants не изобретаются.

Для observation с non-null invoice SQL сначала читает org hint без lock, затем соблюдает TON2 порядок `organization FOR UPDATE → invoice FOR UPDATE`, повторно сверяет invoice/source network+asset+recipient и exact reference из snapshot. Только после этого вставляет observation и делает допустимый status CAS; race с settlement не может вернуть terminal invoice в observed/review. Для `unmatched` invoice ID обязан быть null, status mutation отсутствует, а unique observation key строится без invoice ID.

Полный будущий discovery contract выполняется по chain credit account, не отдельно для каждой invoice. Native source сканирует immutable invoice recipient; jetton source после отдельного Gate 2 сначала должен получить provider-derived wallet для пары `(allowlisted master, invoice recipient owner)`, затем сканировать этот merchant jetton wallet. Source ID детерминирован из provider/network/asset/owner и не зависит от ответа provider. Перед первым scan runner под действующей lease атомарно закрепляет `TonRecipientBinding` (resolved recipient account и native owner либо, только после полного Gate 2, jetton master+owner+wallet) в source cursor row. Source network/provider/asset/owner сверяются с binding. Повторная resolution должна точно совпасть с persisted binding прежде чем использовать LT cursor. Mismatch даёт durable source error `recipient_binding_changed`, оставляет старые mapping и cursor неизменными и не сканирует новый account stream. Исторические invoices продолжают ссылаться на прежний source/binding; автоматическая замена/reset mapping запрещена. Новый binding/migration требует отдельной reviewed recovery процедуры. Native recipient также закрепляется явно.

Exact decoded reference связывается с глобально unique `ton_invoices.reference`; неизвестная/неправильная reference сохраняется один раз как `unmatched` с `invoice_id=NULL` и никогда не переводит случайную invoice в review. После exact reference binding pure verifier проверяет остальные invoice facts, включая совпадение derived/factually credited jetton wallet.

После Task5 database root экспортирует только `createTonInvoice`, `getTonInvoice`, `expireTonInvoice` и public types. Source import fence размещает worker APIs в explicit subpath `@aiag/database/ton-reconciliation-internal`:

```ts
export type TonDatabaseCloseResult =
  | {kind:'closed'}
  | {kind:'deadline_exceeded';phase:'pool'};
export interface CloseableTonWorkerDatabase extends TonPaymentDatabase {
  close(): Promise<TonDatabaseCloseResult>;
}
export function createTonWorkerDatabase(connectionString: string): CloseableTonWorkerDatabase;
export function claimTonReconciliationLease(db: TonPaymentDatabase, input: {
  source:TonReconciliationSource; providerId:'toncenter-v3-testnet';
  leaseOwner:string; leaseMs:90_000;
}): Promise<
  | {kind:'claimed';cursor:TonSweepCursor|null;binding:TonRecipientBinding|null}
  | {kind:'busy'}
  | {kind:'source_identity_mismatch'}
>;
export function bindTonReconciliationRecipient(db: TonPaymentDatabase, input: {
  source:TonReconciliationSource; leaseOwner:string;
  expected:TonSweepCursor|null; binding:TonRecipientBinding;
}): Promise<'bound'|'binding_mismatch'|'lease_lost'|'cursor_conflict'|'source_identity_mismatch'>;
export function listTonReconciliationSources(db: TonPaymentDatabase, input: {
  afterSourceId:string|null; limit:number; assetKind:'native';
}): Promise<readonly TonReconciliationSource[]>;
export function findTonInvoicesForReconciliation(db: TonPaymentDatabase, input: {
  source:TonReconciliationSource; references:readonly string[];
}): Promise<readonly TonInvoice[]>;
export function getTonInvoiceForReconciliation(db: TonPaymentDatabase,
  invoiceId:string): Promise<TonInvoice|null>;
export function recordTonChainObservation(db: TonPaymentDatabase,
  input: TonObservationInput): Promise<TonObservationResult>;
export function renewTonReconciliationLease(db: TonPaymentDatabase, input: {
  sourceId:string; leaseOwner:string; expected:TonSweepCursor|null;
  leaseMs:90_000;
}): Promise<'renewed'|'lease_lost'|'cursor_conflict'>;
export function advanceTonReconciliationCursor(db: TonPaymentDatabase, input: {
  sourceId:string; leaseOwner:string; expected:TonSweepCursor|null;
  next:TonSweepCursor|null; outcome:'success'|'source_error';
  retryAfterMs:number|null; errorCode:TonSourceErrorCode|null;
}): Promise<'advanced'|'lease_lost'|'cursor_conflict'>;
export function releaseTonReconciliationLease(db: TonPaymentDatabase,
  sourceId:string, leaseOwner:string): Promise<'released'|'lease_lost'>;
```

Task 3 создаёт этот subpath только с observation/recovery APIs. Task 5 атомарно удаляет `settleTonInvoice` из root export и добавляет его в этот explicit internal subpath после import-boundary RED; до этого не должно быть двух settlement entrypoints.

`limit` допускает integer `1..16`. В native-only continuation source list принимает literal `assetKind:'native'`, выводит только distinct `(network,native asset,invoice recipient)` из immutable invoices, добавляет `scanFloorTimeMs=min(quoted_at)` и сортируется по `sourceId=sha256(providerId+'\0'+stableAssetJson+'\0'+recipient)`. Для native `stableAssetJson` — exact sorted-key bytes `{"decimals":9,"kind":"native","network":"tvm:-3"}`; recipient — canonical lowercase raw address. `claim` принимает весь source и exact provider ID: wrapper до SQL повторно вычисляет lowercase64-hex source ID и валидирует exact network/native asset/recipient/safe-integer floor; bind дополнительно требует `binding.derivation.kind==='native'`, а `ownerAddress` и `recipientAccount` должны быть равны source invoice recipient. SQL при первом claim сохраняет network/provider, а при конфликте требует их точного совпадения. `source_identity_mismatch` не выдаётся за busy и запрещает binding, provider call и cursor mutation. Jetton rows не выдаются и не получают cursor row до отдельного принятия полного Task 2. Provider scan идёт newest→older по resolved credit-account LT с inclusive one-item overlap, максимум четыре страницы по восемь transactions на source за run и не идёт старше `scanFloorTimeMs`. `cycleUpperLt` фиксирует первый LT цикла: новые transactions выше него будут прочитаны в следующем цикле, а не потеряны посреди descending pagination. На empty page или достижении floor cursor сбрасывается в `null`, поэтому следующий cycle намеренно пересканирует bounded history и увидит поздно проиндексированный transfer; duplicates удаляются по `(account,txHash,messageHash)`. Это консервативный testnet v1 tradeoff; оптимизация high-water/retention требует отдельной policy и не может вводиться скрыто.

**Разделение provider/runner cursor:** `scanAccountPage` владеет одной provider page, проверкой inclusive overlap и возвращает `TonProviderResult.nextCursor/exhausted` (`exhausted` — сигнал endReached). Empty и exact-overlap-only raw pages возвращают `evidence=[]`, `nextCursor=null`, `exhausted=true`; overlap-only не является `pagination_regressed`. Provider не получает `scanFloorTimeMs` или счётчик страниц. Runner владеет floor, четырьмя страницами за run и durable `TonSweepCursor`. При пересечении floor runner сохраняет допустимые observations, затем cursor=null и завершает цикл. После четвёртой non-terminal page он сохраняет observations и точный non-null nextCursor provider, завершает run, но не сбрасывает цикл. Любое продвижение/reset cursor допускается только после durable observations всей принятой части страницы.

Lease не держит SQL transaction во время provider work. `claim`, `bind`, `renew`, observation и `advance` — отдельные завершённые DB операции; provider promise не вызывается из transaction callback. `bind` и `renew` делают CAS по `sourceId+leaseOwner+unexpired lease+expected cursor`; `advance` повторяет тот же fence. `bind` меняет NULL binding один раз; отличный binding, source identity или cursor отвергается до scan. Immutable binding trigger запрещает менять уже установленную пару вне отдельного будущего reviewed recovery gate. Cursor двигается только после durable observations всей принятой части page и, в fixture-only settle mode, после settlement result/ACK каждого связанного candidate.

Все lease mutations используют один DB timestamp в statement (`WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS now)`). `claim` вставляет новый source row или забирает только NULL/expired lease при `next_attempt_at<=tick.now`; existing network/provider mismatch возвращает `source_identity_mismatch`. `renew` выполняет `UPDATE ... SET lease_expires_at=tick.now + interval '90 seconds' WHERE source_id=$1 AND lease_owner=$2::uuid AND lease_expires_at>tick.now AND cursor IS NOT DISTINCT FROM $3::jsonb RETURNING`. Нулевой UPDATE классифицируется в том же prepared statement/transaction snapshot: отсутствующий/другой/expired owner → `lease_lost`, тот же current owner с другим cursor → `cursor_conflict`. `bind` использует тот же owner/expiry/expected-cursor predicate. `advance` применяет его перед изменением cursor/backoff и при success продлевает lease от `tick.now`; stale owner не может ни продвинуть, ни сбросить cursor. `release` очищает только exact current unexpired owner; после takeover/expiry возвращает `lease_lost`.

Backoff вычисляется атомарно в `advanceTonReconciliationCursor` по persisted `consecutive_failures` и `tick.now`; caller передаёт лишь bounded Retry-After, не следующий timestamp. Source-error advance обязан передать `next===expected`, поэтому operational timeout никогда не перескакивает непрочитанную страницу; shutdown cancellation вообще не вызывает advance/backoff. Claim учитывает `next_attempt_at`. Backoff: timeout/5xx — `min(5_000 * 2^(failures-1), 900_000)` ms; `Retry-After` для 429 clamp `1_000..900_000`; остальные source errors используют тот же bounded exponential fallback; successful bounded run сбрасывает failures.

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

- [x] **Step 1: write RED bounds/identity tests.** Use the exact constants and unions above. Assert outer serialized fixture `<=1_048_576` bytes, transactions `<=128`, messages per transaction `<=64`, hashes lowercase64, addresses canonical raw, LT/amount canonical decimal≤78, timestamps safe integers, exact known keys after normalization. Oversized input returns `{kind:'source_error',code:'response_too_large'}` before array mapping/hash work.

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

- [x] **Step 2: run RED.** Run `bunx vitest run apps/worker/src/__tests__/ton-payment-verifier.test.ts`; expected failure is missing modules/exports, not fixture parse failure.
- [x] **Step 3: implement the minimal pure normalizer and verifier.** No `fetch`, env, timers, logger, DB imports or settlement call. Canonicalize once, SHA-256 the stable normalized evidence for `executionPathDigest/evidenceDigest`, and construct `VerifiedChainCredit` only in the `verified` branch with invoice pins copied exactly.
- [x] **Step 4: add the complete adversarial matrix.** Synthetic cases: wrong network/recipient/reference/amount/decimals/sender, fake jetton master, notification-only path, wrong derived wallet, wrong opcode, broken message hash link, duplicate/reordered path, aborted/compute/action failure, bounced input/output, incomplete/emulated trace, inconsistent block/mc anchors, missing depth and arrays at bound/bound+1. Every fixture metadata says `evidenceClass:'synthetic'` and `realProvider:false`.
- [x] **Step 5: run PASS and static boundary checks.** Run focused Vitest and `bun run --filter @aiag/worker type-check`. `rg -n "fetch\(|settleTonInvoice|DATABASE_URL|setInterval" apps/worker/src/ton-payment-{evidence,verifier}.ts` must return no matches.
- [x] **Step 6: review/commit.** Independent TS/security review must confirm pure boundary, reason precedence and no proof claim. Commit only these files with `feat(worker): add pure TON evidence verifier`.

**Gate 1 result:** test code may produce a `VerifiedChainCredit` from synthetic normalized evidence. Task 1 adds no new runtime call path to settlement: source, tests and fixtures may use database types only, with no settlement value import/call. The existing database root export remains until Task 5; this gate does not claim package export isolation or a worker-only security capability. No claim of real provider/testnet verification is allowed.

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

**Native source acceptance (13.09):** `76ff70c` passed independent scoped spec/quality re-review after source fixwave2: all four HIGH addressed; focused234 and covered type/lint gates PASS. This accepts historical native adapter/verification only. Full Task2/jetton remains open. The native-only continuation/lease-budget amendment `5a39f64` is independently approved; Tasks3–6 now follow its sequential implementation gates and controller migration/index ownership.

**Native-only sub-gate (accepted68ddb93 after scoped review):** после принятия provider manifest Steps3–7 могут реализовать только `source.asset.kind='native'`. `resolveRecipientAccount` возвращает canonical native owner address без сети. Для `source.asset.kind='jetton'` он обязан вернуть `{kind:'source_error',code:'unsupported_asset',retryAfterMs:null}` до `fetchImpl` или любой provider/network операции. Это ограничение не маскируется `provider_schema_invalid`. Sub-gate не закрывает Gate2: полный Task2 и jetton auto-credit остаются OPEN до reviewed wallet-derivation mechanism и sanitized complete policy-qualifying jetton success fixture. Native historical provider acceptance не является merchant payment/runtime/settlement acceptance.

**Adapter review amendment13.09 — accepted contract; native source accepted at76ff70c:**

1. Every non-null provider/sweep cursor has all four fields above: bounded canonical decimal `beforeLt` and `cycleUpperLt` (at most78 digits, `beforeLt <= cycleUpperLt`), canonical lowercase64-hex `beforeTransactionHash`, schemaVersion1. Only outer null starts a new cycle. `beforeTransactionHash` pins the final new row of the prior page; compare the next nonempty page's first row to `(recipientAccount,beforeTransactionHash,beforeLt)` before any trace lookup. Whole malformed cursor fails before provider/network. Persist/CAS the entire cursor including hash in Tasks3–4. There is no deployed cursor compatibility to migrate at this local stage.
2. Message `index` is contextual: inbound index0; outgoing index equals zero-based position in its own transaction array. Pure verifier checks this positional invariant and compares cross-transaction messages by every normalized message content field EXCEPT contextual index. Keep index in normalized evidence/digests and candidate receipt identity. A link to the second outgoing message therefore pairs outgoing index1 with recipient inbound index0; duplicate/hash/content/source/destination/opcode/value/reference checks remain mandatory. Add synthetic multi-child proof and mutated content/index rejection tests. This is a correctness fix to the unused v1 verifier, not a relaxation of identity or a new runtime policy.
3. Task2 fixwave ownership expands narrowly to `ton-payment-verifier.ts` and its test for that positional/linkage correction, plus `packages/shared/src/safe-fetch.ts` and a focused test for additive typed redirect classification. `SsrfError` gains optional second constructor reason with default `policy_blocked` and explicit `redirect_limit`; existing one-argument callers/message/name remain compatible. Only the existing maxRedirects exhaustion throw receives `redirect_limit`. TON maps that typed reason to `redirect_rejected`, never error-message text. Other SSRF failures remain fail-closed; no bypass/allowlist or redirect behavior change. Test mocked DNS/fetch through the actual safeFetch branch as well as the adapter seam.
4. A pre-aborted caller signal returns `source_error/timeout` with null retryAfterMs and zero fetch calls; a later abort cancels the internal signal and maps to the same code. Timeout is an operational source-read classification, not a proof of payment failure. This explicitly chooses cancellation behavior without adding a settlement/no-effect meaning.
5. Endpoint validators must enforce EVERY required type/nullability/cross-link in the accepted manifest before setting complete=true, including trace tree/counts/LT/time range and required block/head facts. New required-field mutation tests and checked-in real native success/abort/bounce mapping tests are mandatory. Synthetic mutation derivatives stay in test memory with explicit labels and cannot replace real fixtures. Fixture-backed provider→pure-verifier tests must distinguish structural mapping success from live merchant acceptance.

- [ ] **Step 1: freeze the response manifest before mapping code.** Record exact endpoint paths/query parameters, request order, required fields/types, nullability, pagination direction, content types and fixture SHA-256. At minimum cover transactions by recipient account/time/LT, trace by tx/message hash, masterchain info and jetton master wallet derivation. Store no Authorization header/query secret and no unsanitized raw BOC.
- [ ] **Step 2: enforce evidence labels.** Real files contain `evidenceClass:'sanitized_real_provider_response'`, `providerId`, exact origin, network, `capturedAt`, endpoint path, redactions list and sanitized body. Synthetic files cannot be placed in this directory. A test rejects `evidenceClass:'synthetic'` when loading the real-fixture suite.
- [ ] **Step 3: write RED transport tests.** For the native-only sub-gate, cover native recipient passthrough and jetton `unsupported_asset` with zero `fetchImpl`/provider calls. Successful jetton master+owner wallet resolution tests remain deferred until full Task 2 wallet-derivation and jetton fixture gates pass. Cover non-exact origin, username/password URL, http, port/path/query origin tricks, localhost/127/IPv6/private/link-local/metadata resolution, redirects, oversized/missing `Content-Length`, body crossing 1 MiB while streaming, non-JSON, 401/403, 429 with bounded Retry-After, timeout and 5xx. No test makes a real network call.
- [ ] **Step 4: implement bounded adapter.** Accept only exact `new URL(baseUrl).href === 'https://testnet.toncenter.com/'` and empty username/password; fixed `/api/v3/...` endpoint paths are code constants. Call `safeFetch` with no bypass allowlist and `maxRedirects:0`; abort each call after 8 seconds; reject on header or streamed byte count above 1 MiB before `JSON.parse`. Build queries only with `URLSearchParams` from canonical invoice/cursor fields.
- [ ] **Step 5: map real fixture fields into canonical evidence.** Unknown provider fields may be ignored after total-size bounds, but every required field is type/range checked and missing/null fails closed. Provider `finalized`/`mc_seqno` flags are source facts only; verifier still checks complete trace, cross-links, inclusion anchors and indexed-head depth.
- [ ] **Step 6: verify pagination.** Account pages are descending LT, eight rows; next `beforeLt` overlaps the final row and preserves the first-page `cycleUpperLt`. Test new rows inserted between page calls, inclusive duplicate, empty page, repeated cursor and LT regression. Repeated/regressed cursor returns `pagination_regressed`, never silently skips.
- [ ] **Step 7: focused PASS/review/commit.** Run provider+verifier Vitest and the focused shared safeFetch suite; worker/shared source and involved test files must pass explicit type-check and applicable focused lint after the expanded fix. Independent review must compare mapping with checked-in sanitized fixtures and official source links. Commit `feat(worker): normalize bounded TON Center evidence`.

**Gate 2 result:** without at least one sanitized complete native success and one aborted/bounced failure from the real provider, this task is `BLOCKED_PROVIDER_FIXTURES`; generated example payloads do not satisfy it. Jetton auto-credit remains disabled until a sanitized complete jetton path and wallet-derivation fixture exists. A public historical trace may satisfy the provider-fixture gate; it does not satisfy live merchant testnet payment acceptance.

## Native-only continuation gate for Tasks 3–6 (plan amendment 13.09)

**APPROVED_FOR_IMPLEMENTATION:** amendment `5a39f64` passed independent financial/spec and design re-review; all three HIGH and one MEDIUM addressed. Dispatch remains subject to the controller sequence: freeze migration manifest73 during recovery Task2 native phase, then allow the reserved TON0074 creation. It relies on accepted native source `76ff70c`/owner checkpoint `571ccb1`, but **does not close full Task 2**: jetton wallet derivation, complete sanitized jetton fixture and jetton auto-credit remain OPEN. Tasks 3–6 may cover only `asset.kind='native'`; all data retains explicit asset identity, while source listing, provider calls, new reconciler candidates, fixture-only settlement and observe startup reject/omit jetton. Existing TON2 jetton invoice/settlement behavior is not rewritten or newly accepted. Tasks 1–6 still permit runtime at most `disabled|observe`; this amendment creates no env activation, provider call, DB execution or settlement capability. The authorized fixture-capture RPC budget remains exhausted at `20/20`; no new RPC/capture is added or implied.

### Exact downstream produced/consumed boundary

| Task | Consumes | Produces in this native-only continuation | Explicitly absent |
|---|---|---|---|
| 3 | accepted TON2 DB types/functions; frozen cursor/observation shapes; reserved migration allocation | `0074_ton_reconciliation.sql`, prepared observation/source/lease/binding/renew/advance APIs in `@aiag/database/ton-reconciliation-internal`; native-filtered source list | provider/network work; root settlement export move; runtime config |
| 4 | accepted native provider/verifier; Task 3 internal APIs | observe-only runner whose claim is the sole cursor authority, with aggregate page/DB/close deadlines and fenced cursor; disabled/observe bootstrap kept outside worker index | caller cursor; jetton scan/candidate; settlement dependency; worker startup edit |
| 5 | Task 4 native `verified_candidate`; accepted TON2 settlement wrapper | import fence plus native fixture-injected settlement/replay path | runtime `settle`; new money algorithm/SQL; jetton continuation claim |
| 6 | accepted Tasks 1, native sub-gate, and independently reviewed Tasks 3–5 | one disabled-by-default native observation handle integrated after exclusive index handoff | env activation in this plan wave; jetton; merchant/live transfer; mainnet/production |

### Lease and aggregate provider-page budget

The fixed downstream constants are `TON_LEASE_MS=90_000` and `TON_PROVIDER_PAGE_DEADLINE_MS=60_000`; the accepted provider keeps its internal per-request `TIMEOUT_MS=8_000`. One source run keeps the existing maximum four pages and eight account candidates per page. The 60-second deadline bounds the **whole** `scanAccountPage` call, including transaction-list, all trace/block requests and indexed-head request; it does not multiply by request count. It leaves a nominal 30-second lease reserve, but safety never trusts that reserve: DB clock and post-page CAS decide ownership.

For every page, including the first, runner uses this exact order:

1. Finish claim/binding work, keep `expectedCursor` as the exact canonical cursor returned by claim or last successful advance, then call `renewLease({sourceId,leaseOwner,expected:expectedCursor,leaseMs:90_000})`. `lease_lost`/`cursor_conflict` stops the source before provider work.
2. Create one page controller linked to shutdown signal and a 60-second timer. Race `provider.scanAccountPage(account,expectedCursor,pageSignal)` against that aggregate deadline; every provider request continues to have its own 8-second abort. Clear the timer/listener in `finally`. The runner race returns at the deadline even if an injected/nonconforming provider never settles after abort. It attaches both fulfillment and rejection suppression to that detached promise; any late value/error is consumed only to prevent unhandled completion and is discarded permanently, with no callback retaining DB dependencies.
3. If shutdown is already true when the race result is classified, shutdown wins even when the deadline became ready in the same turn. Stop without a source-error observation and without advance/reset. Best-effort release may run, but cancellation means only that the local reader stopped; it never proves that no chain/payment event occurred. The unchanged cursor makes the next owner replay the page.
4. If aggregate deadline won, abort the page controller and classify only the runner operation as `source_error/timeout`; do not wait for the provider promise. No candidate evidence from that call is observed or settled. When shutdown is still false, run a dedicated post-timeout `renewLease(expectedCursor)` and then `advanceCursor({expected:expectedCursor,next:expectedCursor,outcome:'source_error',errorCode:'timeout',retryAfterMs:null})` solely to persist DB-clock backoff. Loss/conflict stops without backoff. This timeout CAS never advances or resets pagination and is separate from candidate observations and the success-advance branch.
5. If the provider call completed before the aggregate deadline (page or source error), call the same `renewLease` again with unchanged `expectedCursor` **before** writing any observation. On loss/conflict, discard the completed result and stop. This second renew starts a fresh 90-second DB-clock lease for durable result processing. A per-request timeout that completed through provider error uses the same dedicated source-error observation/backoff branch as other completed source errors, with `next===expected`.
6. For a completed page, persist every accepted observation/result. Only after all writes (and Task 5 fixture-only settlement ACKs) call `advanceCursor` with exact `expectedCursor`. A successful page advances to its exact canonical next cursor or null end/floor reset. A completed source error may first persist its page-level source-error observation, then uses the separate `outcome:'source_error'` CAS with `next===expected`; it never enters success advance. `advance` is the final owner/expiry/cursor CAS and extends a successful lease.
7. Runner rechecks the shared shutdown signal before every post-call renew and before either source-error or success advance. If shutdown arrives during observation writes, completed append-only inserts may survive but advance is skipped. If ownership expires during writes, observation dedup may likewise survive but `advance` returns `lease_lost`; replay starts from the prior durable cursor. No stale response, abort, release or local timestamp can advance/reset it.

`close()` first aborts the shared shutdown signal and prevents new source/page work. The shutdown branch wakes the page race immediately; it does not wait for a nonconforming provider tail. DB work and pool shutdown use the separate finite budgets below. Provider cancellation is operational control over reads only; payment discovery remains replay-based and no cancellation result is interpreted as negative chain evidence.

### Bounded DB operations and close contract

The fixed adapter/runner budgets are:

```ts
export const TON_DB_CONNECT_TIMEOUT_MS = 5_000;
export const TON_DB_LOCK_TIMEOUT_MS = 5_000;
export const TON_DB_STATEMENT_TIMEOUT_MS = 8_000;
export const TON_DB_QUERY_TIMEOUT_MS = 9_000;
export const TON_DB_OPERATION_DEADLINE_MS = 10_000;
export const TON_POOL_CLOSE_DEADLINE_MS = 5_000;
export const TON_CLOSE_DEADLINE_MS = 30_000;

export type TonCloseResult =
  | {kind:'closed';mutationOutcome:'known'|'unknown'}
  | {kind:'deadline_exceeded';
      phase:'active_operation'|'release'|'pool';
      mutationOutcome:'known'|'unknown'};
```

`createTonWorkerDatabase` rejects connection-string query settings, case-insensitively, for `connect_timeout`, `statement_timeout`, `query_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` or `options`; caller/env cannot lengthen the owned limits. It creates one `pg.Pool` with `connectionTimeoutMillis:5_000`, `statement_timeout:8_000`, `query_timeout:9_000`, `idle_in_transaction_session_timeout:10_000` and exact startup `options:'-c lock_timeout=5000'`. Every wrapper still uses prepared `{text,values}` SQL. Each transaction owns one checked-out client and has `BEGIN/COMMIT/ROLLBACK` cleanup in `try/catch/finally`; no client is retained by runner/provider callbacks.

The reconciler additionally races **every** DB dependency call—list, claim, bind, renew, invoice lookup, observation, fixture-only settlement, advance and release—against `TON_DB_OPERATION_DEADLINE_MS`. This outer bound also applies to injected/hung test dependencies that ignore driver cancellation. When it wins, the runner suppresses late fulfillment/rejection, starts no dependent DB/provider operation for that source and returns `stopped/db_operation_timeout`; it never describes timeout as rollback. The timed-out observation, settlement, advance or release may have committed before ACK loss. Recovery therefore keeps the last known in-memory cursor out of the public result and requires a fresh claim/read; immutable observation keys and accepted TON2 settlement replay resolve duplicates. A timed-out advance may already have changed durable cursor/backoff, so the caller must not retry it with an assumed cursor in the same run.

Database-adapter `close()` memoizes one `TonDatabaseCloseResult` promise, calls `pool.end()` exactly once and returns `deadline_exceeded/phase:'pool'` if the 5-second pool deadline wins; late fulfillment/rejection is suppressed. Bootstrap `close()` separately memoizes one `TonCloseResult` promise. It aborts new work, gives an already-started runner DB phase only its remaining 10-second operation budget, attempts release once within another 10-second operation budget when the claim ACK made ownership locally known, invokes database `close()` even after either earlier timeout, and returns no later than 30 seconds. It starts no release after an unACKed/timed-out claim because ownership is unknown. A timed-out renew/observation/settlement/advance does not block best-effort release; none of those unknown outcomes is described as rollback.

The result uses the first close phase whose local deadline expired: `active_operation`, then `release`, then `pool`; later phases still run within the overall budget. If no close phase expires and pool close ACKs, result is `closed`. `mutationOutcome:'unknown'` is sticky whenever this runner previously lost a mutation ACK or an active/release mutation times out, including when pool close later ACKs; otherwise it is `known`. A pool timeout always yields `deadline_exceeded/phase:'pool'` unless an earlier close phase already timed out. No close outcome asserts absence of chain activity or absence of a committed TON2 credit.

Shutdown never treats an already-started DB promise as cancelled or rolled back. Its exact phase behavior is:

| DB phase when shutdown becomes known | Required behavior |
|---|---|
| before source list or claim starts | start neither call; return/finish as shutdown with zero source progress |
| during source list or claim | wait only through that call's remaining 10-second outer deadline, suppress any late completion and start no bind/provider work; a timed-out claim has unknown ownership, so do not release it |
| during bind, renew or invoice lookup | let only the already-started call reach ACK or its remaining outer deadline; start no provider, observation, settlement or advance after shutdown; a claim that previously ACKed remains eligible for one bounded release |
| during observation | the one atomic observation/status operation may ACK or have unknown outcome; start no next observation, settlement or advance |
| during fixture-only settlement | the accepted TON2 transaction may ACK or have unknown outcome; start no next candidate or advance, and recover by fresh claim plus idempotent replay |
| during advance | the cursor/backoff CAS may ACK or have unknown outcome; expose no cursor and require fresh claim/read |
| during release | wait only through its remaining operation deadline, mark mutation outcome unknown on timeout, then continue to pool close |
| during pool close | call it once, suppress late completion and return the close result selected above within the overall deadline |

### Mandatory RED matrix before Task 4 implementation

| RED case | Required observable result |
|---|---|
| malformed/noncanonical persisted cursor | rejected before renew/provider; cursor unchanged |
| caller injects legacy/stale `cursor` input | exact-key validation rejects it before claim; claim remains sole cursor authority |
| claim race by two lease UUIDs | exactly one `claimed`; only claimant may resolve/scan |
| source ID/network/provider/native owner mismatch | `not_started/source_identity_mismatch`, no cursor-shaped result field and no binding/provider/cursor mutation |
| `next_attempt_at` not due | `not_started/busy`, no cursor-shaped result field and zero provider calls |
| pre-page renew sees expired/replaced owner | `lease_lost`; zero provider calls |
| pre-page renew sees same owner but changed cursor | `cursor_conflict`; zero provider calls |
| one request reaches its 8-second timeout | completed source-error observation/backoff only after post-call renew; `next===expected`, no success advance |
| aggregate page exceeds 60 seconds across otherwise sub-8-second requests | runner returns without awaiting provider; no candidate observation; late value/error suppressed; dedicated timeout backoff CAS has `next===expected` |
| source error on page 2, 3 or 4 | result retains `processed/pagesAdvanced` from earlier success-ACKed pages; failing page contributes neither count |
| shutdown and aggregate deadline become ready together | shutdown wins; no timeout observation/backoff/advance; late provider completion suppressed |
| shutdown during provider page | page race wakes immediately; no observation/backoff/advance; cancellation is not negative chain evidence |
| shutdown after provider completion, before post-page renew | do not start renew/observation/advance; completed provider value discarded |
| shutdown during already-started post-page renew | renew may ACK or time out and may have extended lease; start no observation/advance; do not claim rollback |
| shutdown after renew ACK, before first observation | start no observation/advance; release remains best effort within close budget |
| shutdown during an already-started observation | that atomic observation/status transaction may ACK or have unknown outcome; start no later observation and no advance |
| shutdown after last observation ACK, before advance | all observations may remain, but do not start advance; page replays/deduplicates |
| shutdown during already-started advance | advance may ACK or have unknown durable outcome; expose no cursor and require fresh claim/read |
| provider resolves after deadline/shutdown | late result cannot write observation, settle or cursor; no unhandled rejection |
| provider result then lease takeover before post-page renew | page discarded; no cursor move/reset |
| lease expires during page observation writes | inserted observations remain deduplicable; final advance=`lease_lost`; replay from old cursor |
| crash after provider/before first observation | old cursor remains; replay reads the same page |
| crash mid-page observations | old cursor remains; replay returns the same observation IDs for completed inserts |
| crash after all observations/before advance commit | old cursor remains; page replay deduplicates all observations |
| advance commit succeeds but client loses ACK | persisted new cursor/backoff is authoritative; retry with old expected gets `cursor_conflict` |
| empty/exhausted or floor-crossing page | null reset only after all retained observations and successful final CAS |
| fourth nonterminal page | exact non-null provider cursor persisted; cycle is not reset |
| source error/429 Retry-After | DB-clock backoff applied; cursor byte-for-byte unchanged; clamp `1_000..900_000` |
| inclusive overlap/new rows above `cycleUpperLt` | duplicate overlap removed, no gap; above-upper rows deferred to next null cycle |
| injected jetton source/candidate | rejected before provider and DB status/cursor mutation; full Task 2 stays OPEN |
| provider promise held at a test barrier | no checked-out SQL transaction remains open while it is pending |
| source-list promise never settles | scheduler returns/records DB operation timeout within 10s; no claim/provider work starts; late result suppressed |
| claim promise never settles | return `stopped/db_operation_timeout` within 10s with zero counts; ownership is unknown, so close starts no release; no provider work |
| bind or invoice-lookup promise never settles | return within 10s; start no dependent provider/observation/settlement/advance; a previously ACKed claim may receive one bounded release |
| renew promise never settles | return `stopped/db_operation_timeout` within 10s; late result suppressed; no observation/advance |
| observation promise never settles | return within 10s; no later observation/advance; commit outcome explicitly unknown |
| fixture settlement promise never settles | return within 10s with prior-page counts; start no later candidate/advance; settlement outcome unknown and replay required |
| advance promise never settles | return within 10s with no cursor; fresh claim/read required because cursor/backoff may have committed |
| release promise never settles | close continues to pool close; mutation outcome unknown; total close remains within 30s |
| pool end never settles | one pool-end call; return `deadline_exceeded/phase:'pool'` within overall 30s; late result suppressed |
| fixture `settled`/`already_settled` ACK then crash before advance | prior verified observation and TON2 decision/receipt/grant survive; cursor unchanged; replay returns accepted idempotent result and one grant total |
| fixture `review_required` ACK then crash before advance | TON2 review decision survives; cursor unchanged; replay returns the same durable decision before success advance is eligible |
| fixture `evidence_conflict` before/after review-observation ACK | before ACK no advance; after commit/lost ACK cursor remains unchanged and replay deduplicates the immutable conflict observation |
| fixture `not_found` | exact `stopped/settlement_not_found` with prior-page counts; no later candidate/advance and no cursor field |
| fixture settlement/advance commit with lost caller ACK | return DB timeout/unknown outcome without cursor; fresh claim/replay reads the durable decision/cursor and never duplicates a grant |
| repeated/concurrent `close()` | one memoized close promise, abort/release/pool close at most once, no new page and no late cursor write |

## Task 3: append-only observations and durable lease/cursor

**Files:**
- Create: `packages/database/migrations/0074_ton_reconciliation.sql` after confirming reserved catalog `0073` ownership and rechecking the manifest; if `0074` is occupied, stop and update this plan to the actual next ID before implementation and independent review.
- Modify: `packages/database/src/schema/ton-payments.ts`
- Modify: `packages/database/src/ton-payment-types.ts`
- Modify: `packages/database/src/ton-payments.ts`
- Create: `packages/database/src/ton-reconciliation-internal.ts`
- Modify: `packages/database/tsup.config.ts`
- Modify: `packages/database/package.json`
- Create: `packages/database/src/__tests__/ton-reconciliation.test.ts`
- Create: `packages/database/scripts/__tests__/ton-reconciliation.native.integration.test.ts`
- Modify: `packages/database/scripts/__tests__/native-migrate.test.ts` only for manifest length73→74 and final migration filename0074; preserve all other assertions.

**Interfaces:**
- Consumes: persistence contract above; accepted TON2 `TonPaymentDatabase` and invoice JSON projection.
- Produces: explicit internal subpath APIs above. `settleTonInvoice` moves off the root export in Task 5, not yet in this task.

- [ ] **Step 1: recheck migration manifest and ownership.** Run `find packages/database/migrations -maxdepth 1 -type f -printf '%f\n' | sort | tail` and inspect controller ownership. Treat Catalog Task 2's `0073_gateway_catalog_revision.sql` as reserved even if not yet present; use `0074_ton_reconciliation.sql`. If `0074` is occupied/reserved, stop for plan-only renumbering and review; never rename/rewrite an applied or current catalog migration.
- [ ] **Step 2: write RED wrapper/schema tests.** Test strict cursor/observation/source/binding key sets, canonical UUID/address/hash/LT/time, recomputed source ID, native-only list filter, limits before serialization and prepared `{text,values}` queries. Reject `limit=0|17`, forged result kind/reason pairing, non-null invoice on `unmatched`, missing event identity on candidate results and snapshot>32768 bytes before SQL. Cover claim identity mismatch plus bind/renew/advance exact expected-cursor validation.
- [ ] **Step 3: write RED native concurrency/restart tests on an owned disposable loopback DB.** Implement the Task 4 RED matrix cases that belong to persistence: claim race, expired takeover, DB-clock renew, stale owner renew/advance/release, same-owner cursor conflict, null wrap, deterministic native-only source listing, exact unique reference binding across pending/observed/expired/settled/review invoices, unknown reference→one nullable-invoice observation с invoiceStatus:null, pinned recipient mismatch→no cursor reuse and old binding preserved, exponential backoff/Retry-After clamp and not-due denial, duplicate observation ID, immutable UPDATE/DELETE and allowed status transitions.
- [ ] **Step 4: implement additive migration/functions.** Use the exact two-table schema above, a source-scan index on `ton_invoices(network,asset_kind,master_address,asset_decimals,recipient,created_at,id)` and observation index `(invoice_id,created_at,id)`, immutable trigger and prepared SQL functions. Observation insert+invoice status CAS is one transaction. Claim/bind/renew/advance/release follow the exact single-DB-clock and result-classification semantics in the native continuation gate; every mutation fences `sourceId+leaseOwner+unexpired lease`, and bind/renew/advance additionally fence the entire expected cursor with `IS NOT DISTINCT FROM`. Function validation enforces the exact result-kind/reason unions and nullable invoice/event rules before casts.
- [ ] **Step 5: create bounded closeable native DB adapter.** Implement the exact connection-string rejection, pool timeouts, transaction cleanup, 10-second operation boundary and 5-second memoized `close()` result above. Neon HTTP is rejected for this callback transaction boundary. Tests inject fake pool/client promises for hung checkout/query/COMMIT/ROLLBACK/pool end; a timeout is an unknown outcome, never rollback proof. Credentials are never logged.
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
- Consumes: accepted native provider/verifier and Task 3 internal native-source/observation/claim/bind/renew/advance/release APIs. Settlement dependency is deliberately absent.
- Produces: `reconcileTonInvoice(...)`; `reconcileTonInvoices({source,limit,signal},deps): Promise<TonReconcileSourceResult>` with claim-owned cursor and explicit completion/source-error/not-started/stop status; `startTonObservationFromEnv(deps): Promise<{close():Promise<TonCloseResult>}>` supporting only `disabled|observe`.

```ts
export interface TonObserveReconcilerDeps {
  getInvoice(invoiceId:string):Promise<TonInvoice|null>;
  listSources(input:{afterSourceId:string|null;limit:number;assetKind:'native'}):
    Promise<readonly TonReconciliationSource[]>;
  findInvoices(input:{source:TonReconciliationSource;
    references:readonly string[]}):Promise<readonly TonInvoice[]>;
  provider:TonEvidenceProvider;
  recordObservation(input:TonObservationInput):Promise<TonObservationResult>;
  claimLease(input:{source:TonReconciliationSource;
    providerId:'toncenter-v3-testnet';leaseOwner:string;leaseMs:90_000}):Promise<
      | {kind:'claimed';cursor:TonSweepCursor|null;binding:TonRecipientBinding|null}
      | {kind:'busy'}
      | {kind:'source_identity_mismatch'}>;
  bindRecipient(input:{source:TonReconciliationSource;leaseOwner:string;
    expected:TonSweepCursor|null;binding:TonRecipientBinding}):Promise<
      'bound'|'binding_mismatch'|'lease_lost'|'cursor_conflict'|'source_identity_mismatch'>;
  renewLease(input:{sourceId:string;leaseOwner:string;
    expected:TonSweepCursor|null;leaseMs:90_000}):
    Promise<'renewed'|'lease_lost'|'cursor_conflict'>;
  advanceCursor(input:{sourceId:string;leaseOwner:string;expected:TonSweepCursor|null;
    next:TonSweepCursor|null;outcome:'success'|'source_error';
    retryAfterMs:number|null;errorCode:TonSourceErrorCode|null}):
    Promise<'advanced'|'lease_lost'|'cursor_conflict'>;
  releaseLease(sourceId:string,leaseOwner:string):Promise<'released'|'lease_lost'>;
  newLeaseOwner():string;
}
export type TonReconcileItemResult =
  | { kind:'not_found' }
  | { kind:'source_error'; code:TonSourceErrorCode }
  | { kind:'unmatched'; evidenceDigest:string }
  | { kind:'observed'; reason:TonObservedReason }
  | { kind:'review_required'; reason:TonReviewReason }
  | { kind:'verified_candidate'; credit:VerifiedChainCredit };
export type TonReconcileSourceResult =
  | {kind:'completed';processed:number;pagesAdvanced:number}
  | {kind:'source_error';code:TonSourceErrorCode;
      processed:number;pagesAdvanced:number}
  | {kind:'not_started';reason:'busy'|'source_identity_mismatch'}
  | {kind:'stopped';reason:
      'shutdown'|'lease_lost'|'cursor_conflict'|'db_operation_timeout'|'db_error'|
      'settlement_not_found';
      processed:number;pagesAdvanced:number};
export function reconcileTonInvoice(
  input:{invoiceId:string;cursor:TonSweepCursor|null;limit:number;signal:AbortSignal},
  deps:TonObserveReconcilerDeps,
):Promise<TonReconcileItemResult>;
export function reconcileTonInvoices(
  input:{source:TonReconciliationSource;limit:number;signal:AbortSignal},
  deps:TonObserveReconcilerDeps,
):Promise<TonReconcileSourceResult>;
```

`reconcileTonInvoices` validates exact input keys and rejects any injected legacy/stale `cursor` key before claim. Only `{kind:'claimed'}` initializes `expectedCursor`; every later in-memory value comes only from an ACKed success `advanceCursor`. Results never expose a cursor: a fresh claim is the only read authority after busy, identity mismatch, lost ACK, timeout or takeover. `processed` is the count of evidence candidates on pages whose **success** cursor advance was ACKed in this source run; `pagesAdvanced` counts those pages. Neither includes observations from an unadvanced replayable page or a source-error backoff CAS. Thus a source error on page 2–4 returns the accumulated counts from earlier ACKed pages instead of zero.

- [ ] **Step 1: write RED orchestration tests.** Assert durable sequence `list native sources → claim exact source → resolve native account without network → bind/compare under expected-cursor lease CAS → pre-page renew → aggregate-bounded scan outside transaction → post-page renew → exact-reference lookup → verify/unmatched → durable observations → advance`. Inject every crash/ACK-loss point from the mandatory RED matrix; restart with a new owner uses persisted cursor/observation, does not lose a transfer and deduplicates replay.
- [ ] **Step 2: cover complete result/deadline behavior.** Implement every non-concurrency row in the mandatory RED matrix with fake timers and deferred provider/DB promises. Empty page/`candidate_not_found`, `trace_incomplete` and `finality_pending` remain retryable; deterministic verifier rejection records review; unknown reference records one `unmatched` observation with no invoice transition; source errors record no raw body and apply exact backoff. Out-of-order evidence, rows inserted above `cycleUpperLt`, page boundary overlap, end-of-cycle null wrap, per-request timeout, aggregate page deadline, late resolve and every shutdown/DB-timeout phase preserve the specified durable cursor. Tests assert the exact result union, accumulated `processed/pagesAdvanced`, no cursor-shaped field, and that abort/timeout is not negative chain/payment evidence.
- [ ] **Step 3: cover concurrency and transaction boundary.** Implement every concurrency/crash/close row in the mandatory RED matrix. Two runners with different lease UUIDs process one source; only claimant calls provider. Post-page renewal loss discards the result; loss during observation permits deduped inserts but final advance must fail. Hold provider, renew, observation, advance and release promises at separate barriers and assert the overall operation/close deadlines, late suppression, one pool close, and that no checked-out transaction/client remains around provider orchestration. Injected jetton source fails before provider and DB status/cursor mutation.
- [ ] **Step 4: implement observe-only reconciler.** `verified` produces `verified_candidate` observation only. No settlement function/dependency/import exists. Apply the exact 90-second lease, 60-second aggregate page, 10-second DB operation and existing 8-second request sequence above; cap one source run at four provider pages of eight candidates. A source-error advance always passes `next===expected`; only an ACKed success CAS updates the private `expectedCursor` and increments `processed/pagesAdvanced`. No source result returns that cursor.
- [ ] **Step 5: implement fail-closed bootstrap.** Unset/`disabled` returns a no-op handle before provider/DB factories. `observe` requires exact native asset/policy/version/source/origin and `DATABASE_URL`; unknown mode, including `settle`, throws before factories. Timer is unref'd and never overlaps its previous run. `close()` follows the bounded idempotent shutdown sequence above; a late provider result has no DB consumer.
- [ ] **Step 6: run PASS/review/commit.** Run reconciler/bootstrap/provider/verifier tests and worker type-check/lint. Assert disabled config makes zero TON provider, DB, timer and dynamic internal-package factory calls; existing Redis behavior is outside this assertion. Commit `feat(worker): add observe-only TON recovery sweep`.

## Task 5: source import fence and crash-safe settlement caller in fixtures

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
- Consumes: pure native `verified` result and explicit `settleVerifiedCredit(invoiceId,credit)` dependency supplied only by isolated fixture harness in this task. Runtime bootstrap never supplies it before the separate authorization gate.
- Produces: internal native fixture settlement path; runtime bootstrap supports only `disabled|observe`, including after Gate5 acceptance. The generic accepted TON2 wrapper remains capable of validating its existing asset contract, but no new jetton provider/reconciler acceptance follows from this task.

```ts
export interface TonFixtureSettlementDeps {
  settleVerifiedCredit(
    invoiceId:string,
    credit:VerifiedChainCredit,
  ):Promise<TonSettlementResult>;
}
```

The fixture harness supplies exactly this dependency; the runtime bootstrap type has no such field. The call is made only after the same candidate's durable `verified_candidate` observation ACK (`inserted|already_recorded`). The fixture path validates the accepted `TonSettlementResult` exact-key union before acting on it. A settlement ACK makes only that candidate eligible; the page enters success advance only after **every** candidate has its required durable ACK. The result never carries a cursor.

| `settleVerifiedCredit` outcome | Durable prerequisite/ACK | Cursor and exact source-result behavior |
|---|---|---|
| `settled` | returned accepted TON2 receipt proves the settlement transaction committed its event, `settled` decision, invoice receipt and one grant; the prior `verified_candidate` observation is already durable | candidate ACKed; after all page candidates ACK, run success advance. Only its ACK adds this page's candidates to `processed` and one to `pagesAdvanced`; run later returns `completed`, or retains those counts in a later `source_error`/`stopped` result |
| `already_settled` | returned accepted TON2 receipt proves durable replay of the existing `settled` decision/receipt/grant; prior `verified_candidate` observation remains durable | same success-advance/result rule as `settled`; replay never issues a second grant |
| `review_required` | exact returned `invoiceId` plus `eventId`/`reason` ACK the accepted TON2 durable event decision and its guarded invoice-status outcome; an already terminal invoice remains terminal, and the prior `verified_candidate` observation remains durable | candidate is durably handled and uses the same success-advance/result rule; review is never counted before that page's advance ACK |
| `evidence_conflict` | the settlement result alone is **not** a page ACK because the accepted TON2 function returns an existing conflicting event without an invoice decision. Before advance, write and ACK (`inserted|already_recorded`) a second immutable `review_required/settlement_evidence_conflict` observation for this invoice/candidate, with returned `eventId` in the bounded sanitized snapshot; this is the durable manual-review record | after that observation ACK, candidate uses the same success-advance/result rule. If its write throws/times out, return `stopped/db_error` or `stopped/db_operation_timeout` with counts from earlier ACKed pages and do not advance this page |
| `not_found` | no receipt, event decision, invoice status or new durable review record is proven | stop the source immediately as `stopped/settlement_not_found`, retain counts only from earlier ACKed pages, start no later candidate/advance and expose no cursor; a future fresh source claim/read decides recovery |
| throw/reject | no settlement ACK is known | `stopped/db_error`, prior-page counts only, no later candidate/advance and no cursor |
| 10-second outer DB deadline | commit/ACK outcome is unknown; late fulfillment/rejection is suppressed | `stopped/db_operation_timeout`, prior-page counts only, no later candidate/advance and no cursor; fresh claim/replay resolves through accepted TON2 idempotency |

Accordingly `TonReconcileSourceResult.stopped.reason` also includes `'settlement_not_found'` in the fixture-only Task 5 build. This is orchestration classification only; it adds no settlement SQL, financial branch or runtime mode.

The canonical one-page/one-candidate RED expectations remove any aggregate ambiguity: `settled`, `already_settled`, `review_required`, and `evidence_conflict` after its review-observation ACK each return `{kind:'completed',processed:1,pagesAdvanced:1}` only after success-advance ACK. `not_found` returns `{kind:'stopped',reason:'settlement_not_found',processed:0,pagesAdvanced:0}`. A thrown dependency returns the same zero counts with `reason:'db_error'`; a lost/timed-out ACK uses `reason:'db_operation_timeout'`. Multi-page runs apply the prior-page accumulation rule in the table.

- [ ] **Step 1: write RED import-boundary test.** Assert root `@aiag/database` declaration/export has no value export named `settleTonInvoice`. Its definition may remain in `packages/database/src/ton-payments.ts`; only `packages/database/src/ton-reconciliation-internal.ts` may re-export it, package tests/native fixtures may import it for accepted coverage, and only `apps/worker/src/ton-payment-bootstrap.ts` may consume the internal package subpath at runtime. Assert `apps/web` and `packages/api-gateway` contain neither internal subpath import nor `aiag_settle_ton_invoice_v1`.

```ts
expect(databaseRoot).not.toMatch(/settleTonInvoice/);
expect(forbiddenRuntimeFiles).toEqual([]);
expect(workerInternalImporters).toEqual(['apps/worker/src/ton-payment-bootstrap.ts']);
```

- [ ] **Step 2: move root settlement export.** Remove only `settleTonInvoice` from `packages/database/src/index.ts`; preserve its type contracts. Export the value only from the explicit internal subpath. Update database tests/native fixtures to import that explicit source/subpath without weakening TON2 assertions.
- [ ] **Step 3: inject native settlement into reconciler fixtures.** In a fixture-injected `mode:'settle'` path (unreachable from runtime bootstrap), reject non-native source/credit before the dependency and call only after native `result.kind==='verified'` plus durable `verified_candidate` observation. Implement the exact dependency signature and complete branch table above. `observed`, verifier `review_required`, `source_error` and jetton cannot reach the dependency by type switch and tests.
- [ ] **Step 4: test every ACK/crash/concurrency branch.** For each of `settled`, `already_settled`, `review_required`, `not_found` and `evidence_conflict`, test the returned source union, prior-page counts and absence of any cursor field. Put barriers immediately before settlement, after its durable commit but before caller ACK, after its return but before required conflict observation, after that observation's commit but before ACK, after all candidate ACKs but before advance, and after advance commit but before ACK. Before settlement leaves no grant and no advance; lost settlement ACK stops with unknown outcome and replay resolves through `already_settled` or the same durable review decision; lost conflict-observation ACK replays its immutable key. `not_found` and thrown calls never advance. Concurrent on-demand/sweep native candidates produce one TON event/receipt/grant through accepted TON2 guards.
- [ ] **Step 5: prove no forgery seam.** Tests pass malformed/fake user JSON, HTTP-style `{verified:true}`, raw BOC and provider `finalized:true`; none type-normalize into `VerifiedChainCredit` or call settlement. Future API may pass only `invoiceId` to `reconcileTonInvoice`; no HTTP handler receives credit/evidence.
- [ ] **Step 6: focused PASS and two reviews.** Run database TON wrapper tests, worker verifier/reconciler/import-boundary tests, new native reconciliation suite and both package type-checks/lint. Require independent financial/security review of grant reachability and separate TS review of imports/restart behavior.
- [ ] **Step 7: commit.** Commit `refactor(ton): fence settlement source imports`.

**Gate 5 result:** current source call graph reaches settlement through the reviewed worker injection seam, exercised only with mocked/disposable fixture dependencies. An internal package export and import tests are a maintenance fence, not a security capability: any workspace package with the same DB credentials could import/call the function. Bootstrap continues to reject `settle`. Runtime settlement activation requires the separate DB authorization gate below; source fencing cannot satisfy it.

## Task 6: controlled disabled-by-default observation startup

**Files:**
- Modify: `apps/worker/src/ton-payment-bootstrap.ts`
- Modify: `apps/worker/src/__tests__/ton-payment-bootstrap.test.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/__tests__/ton-payment-import-boundary.test.ts`
- Create: `docs/product/acceptance/ton-verifier-testnet.md`

**Interfaces:**
- Consumes: accepted native Gate 5 source/reviews, exact provider/policy constants and exclusive ownership of `apps/worker/src/index.ts` after Recovery Task 3 releases it.
- Produces: `startTonReconciliationFromEnv(): Promise<{close():Promise<TonCloseResult>}>` with native `disabled|observe`; the worker graceful-close path awaits and reports the exact bounded result above. `settle` and jetton always fail closed in this task.

- [ ] **Step 1: hard prerequisite and index-ownership check.** Do not start this task unless Tasks 1 and native-only 2–5 commits, native sanitized provider fixtures, fresh focused/native results, independent financial/security + TS reviews and import-boundary test are all recorded. Recovery Task 3 owns the shared worker index first; controller must record its accepted commit and release of `apps/worker/src/index.ts`, then assign that whole file exclusively to TON Task 6. If either prerequisite or exclusive handoff is absent, report `BLOCKED_OBSERVATION_STARTUP` or `BLOCKED_WORKER_INDEX_OWNERSHIP` and stop without editing startup. Do not wait for full jetton Task 2 to run native observe mode, and do not describe jetton as accepted.
- [ ] **Step 2: write RED startup tests.** Unset/`disabled` performs zero TON DB/provider/timer calls. Unknown mode, `settle` and any jetton asset mode fail closed before factories. Native `observe` cannot receive settlement dependency and requires exact provider origin/network/policy/version/source ID and database URL before constructing resources; mismatch fails before network/DB. `close()` passes every phase, timeout, result precedence and repeated/concurrent shutdown row in the mandatory RED matrix.
- [ ] **Step 3: wire observe mode behind exact config.** The bootstrap dynamically imports observation/recovery APIs from `@aiag/database/ton-reconciliation-internal` only after validation and never injects settlement in this task. No default API key is invented; an optional existing secret is passed only as a header and never logged/persisted. Default remains `disabled`.
- [ ] **Step 4: wire index minimally under serialized ownership.** Re-read `apps/worker/src/index.ts` at the accepted Recovery Task 3 commit after its owner releases the file. With TON holding exclusive whole-file ownership, add one bootstrap call after `loadSharedEnv()` and include its `close()` in existing graceful shutdown; do not overlap edits with Recovery Task 3. Run a final integration diff/review against both accepted commits before release. Do not reuse Redis/BullMQ for the TON cursor and do not change old cron behavior. If TON startup fails in enabled mode, worker fails closed and closes already-created TON resources.
- [ ] **Step 5: prove controlled behavior.** Run worker bootstrap/import-boundary/reconciler/provider/verifier tests plus worker type-check/lint. A source-level test confirms `index.ts` has one TON bootstrap call and no direct provider/DB/settlement import. Disabled test distinguishes “zero TON calls” from the worker's existing Redis/network behavior.
- [ ] **Step 6: run observe-only real-provider evidence check.** This remains a later explicit-authorization gate and is not activated by the plan amendment. With explicit authorization and no signer/funds, run one bounded read-only testnet provider observation against the pinned origin; save only sanitized request manifest/result/check time. It may validate retrieval and restart, not payment ownership or live transfer.
- [ ] **Step 7: preserve the live testnet gate.** The acceptance document must list successful/aborted/bounced/late native and jetton transfer evidence, restart/replay and one-credit conservation as unverified until an isolated signer/test assets/funds are separately authorized. Synthetic and historical provider fixtures cannot mark these PASS. Mainnet and production remain blocked.
- [ ] **Step 8: final review/commit.** Independent review confirms default disabled, exact pinning, loopback/redirect guard, cleanup and no Web/API route. Commit `feat(worker): gate TON reconciliation startup`.

## Separate runtime settlement authorization gate

Tasks 1–6 do not enable runtime settlement. Before any later `settle` mode, a separate reviewed implementation must provision and prove a worker-only DB principal/ACL boundary: Web/API principals cannot execute the settlement SQL function or mutate protected event/receipt/grant tables through alternative paths; worker credentials remain server-side and distinct. Native negative permission tests must use those exact role grants, including direct SQL, inherited privileges and default PUBLIC privileges, with positive worker settlement and one-credit replay tests. The accepted TON2 SQL/migration stays immutable; any ACL migration/config is a separate next-numbered change and deployment/credentials receive their existing authorization gate. A package subpath, structural TypeScript type, env flag, or rg call-graph test never substitutes for this evidence. If the gate is unavailable, observe mode remains the maximum runtime mode.

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
- after Task5 root/public source still exports settlement, current Web/API source imports the internal subpath, or disabled mode constructs TON DB/provider resources; an absent import proves only the present call graph, never DB permission isolation;
- migration number is occupied, checksum differs, disposable DB identity/cleanup is not proven, or concurrent lease/cursor tests fail;
- evidence pins differ from immutable invoice, or a test only passes by calling `settleTonInvoice` with handcrafted credit outside the worker seam.

No stop condition authorizes a fallback to indexer flags, client wallet success, raw JSON/BOC, a different provider, mainnet, or a looser historical invoice policy.

## Independent architecture review — 13.09.2026

Task 1 pure synthetic slice APPROVE independently, with the corrected Gate 1 above and boundary checks covering its source/tests/fixtures. Full Tasks2–6 remain BLOCK pending explicit fixes for durable resolved wallet/cursor binding, complete lease/backoff dependencies, nullable unmatched observation result, and an honest source import fence versus worker-only DB authorization gate. No implementation beyond Task 1 is accepted by this review.

**Review fix candidate:** resolved-recipient binding is persisted and immutable; mismatch preserves old history/cursor and forbids scan. Lease deps are explicit and backoff uses atomic DB clock/state. Unmatched returns invoiceStatus:null. Tasks1–6 runtime is at most observe-only; settlement awaits separate worker DB principal/ACL proof. Independent scoped re-review pending.

**Scoped re-review 13.09 — APPROVE:** amendment `4eaa44d` закрывает все четыре blockers; существенных новых противоречий нет. Literal sourceId/network/provider/asset/owner validation against pinned recipient binding остаётся обязательной реализационной проверкой. Это принятие архитектурного плана Tasks1–6 с runtime максимум observe, не verifier/provider/testnet acceptance. Task1 продолжает отдельную реализацию/review.

**Task1 source принят13.09:** `f46386c` + fix `b17603e`, independent TS/security scoped re-review APPROVE. Final46 focused tests, worker TypeScript/applicable focused ESLint и all-five-file boundary scans PASS. Закрыты unbounded pre-serialization, dangling/disconnected complete trace и conflicting block-coordinate identity. Проверки доказывают только pure synthetic behavior; actual provider fixture/RPC/runtime/settlement отсутствуют. Следующий этап Task2 начинается с exact response manifest и sanitized real fixtures, без ослабления обязательных полей.
