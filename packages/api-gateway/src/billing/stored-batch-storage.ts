import { createHash } from 'node:crypto';
import { sql as defaultSql, type SqlClient } from '../lib/db';
import {
  admissionJsonObjectsEqual,
  normalizeAdmissionTimestamp,
  normalizeAdmissionUuid,
  parseAdmissionBigint,
  parseAdmissionJsonObject,
  parseGatewayChargeAdmissionResult,
  type GatewayChargeAdmissionResult,
  type JsonObject,
} from './admission-result';
import { admissionProjection } from './admission-internal';
import { admitGatewayChargeV2 } from './quota-admission';
import type { StoredBatchPreparedItem } from './stored-batch-item-preparation';

export type StoredBatchStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'reconciliation_required';

export type StoredBatchItemStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'reconciliation_required';

export type StoredBatchRead = Readonly<{
  id:string;
  batchId:string;
  orgId:string;
  apiKeyId:string|null;
  batchType:string;
  status:StoredBatchStatus;
  totalCount:number;
  completedCount:number;
  failedCount:number;
  reconciliationCount:number;
  settledMicrocredits:bigint;
  contractVersion:number;
  billingMode:string|null;
  idempotencyKeyDigest:string|null;
  requestFingerprint:string|null;
  queuedAt:string|null;
  reconcileAfter:string|null;
  terminalAt:string|null;
  createdAt:string;
  expiresAt:string;
}>;

export type StoredBatchResultItem = Readonly<{
  index:number;
  customId:string;
  status:StoredBatchItemStatus;
  output:JsonObject|null;
  errorCode:string|null;
  settledMicrocredits:bigint|null;
}>;

export type StoredBatchResultPage = Readonly<{
  items:readonly StoredBatchResultItem[];
  nextCursor:number|null;
}>;

export type StoredBatchWorkerItem = Readonly<{
  id:string;
  parentId:string;
  batchId:string;
  itemIndex:number;
  customId:string;
  routeKind:'chat'|'embeddings'|'completions';
  requestFingerprint:string;
  requestBody:JsonObject;
  billingRequestId:string;
  attemptId:string;
  modelSlug:string;
  modelUpstreamId:string;
  upstreamId:string;
  upstreamModelId:string;
  adapterKey:string;
  pricingSnapshot:JsonObject;
  providerRequest:JsonObject;
  status:StoredBatchItemStatus;
  deadlineAt:string;
  admission:GatewayChargeAdmissionResult;
}>;

export type StoredBatchPendingEvidence = Readonly<{
  output:JsonObject;
  usageSnapshot:JsonObject;
  actualCostCredits:bigint;
  resultDigest:string;
}>;

export type StoredBatchEvidenceRecoveryCandidate = Readonly<{
  itemId:string;
  parentId:string;
  batchId:string;
  billingRequestId:string;
  admissionState:'dispatched'|'outcome_recorded'|'settled';
  evidence:StoredBatchPendingEvidence|null;
}>;

export class StoredBatchConflictError extends Error {
  readonly code='BATCH_IDENTITY_CONFLICT';
  constructor(){super('Stored batch identity conflict');this.name='StoredBatchConflictError';}
}
export class StoredBatchStorageError extends Error {
  readonly code='BATCH_STATE_UNAVAILABLE';
  constructor(message='Stored batch state unavailable'){super(message);this.name='StoredBatchStorageError';}
}

type RootSql = typeof defaultSql;
type TransactionClient = SqlClient;

export type CreateStoredBatchArgs = Readonly<{
  orgId:string;
  apiKeyId:string;
  batchId:string;
  batchType:'chat'|'embeddings'|'completions';
  contractVersion:5;
  billingMode:'stored';
  idempotencyKeyDigest:string;
  requestFingerprint:string;
  expiresAt:string;
  items:readonly StoredBatchPreparedItem[];
}>;

const HEX64=/^[0-9a-f]{64}$/;
const BATCH_ID=/^batch_[0-9a-f]{32}$/;
const ERROR_CODE=/^[A-Z0-9_]{1,64}$/;

function boundedInt(value:unknown,name:string):number{
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<0) throw new StoredBatchStorageError(name);
  return n;
}
function nullable(value:unknown):string|null{return value===null||value===undefined?null:String(value);}
function uuid(value:unknown):string{return normalizeAdmissionUuid(value);}
function object(value:unknown):JsonObject{return parseAdmissionJsonObject(value);}
function canonicalJson(value:unknown):string{
  if(value===null||typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record=value as Record<string,unknown>;
  return `{${Object.keys(record).sort().map((key)=>`${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
function digestJson(value:JsonObject):string{return createHash('sha256').update(canonicalJson(value)).digest('hex');}
function parsePendingEvidence(value:unknown):StoredBatchPendingEvidence{
  const parsed=object(value);
  const keys=Object.keys(parsed).sort();
  if(keys.join(',')!=='actualCostCredits,output,resultDigest,usageSnapshot') throw new StoredBatchStorageError('pending_evidence');
  const output=object(parsed.output);
  const usageSnapshot=object(parsed.usageSnapshot);
  const actualCostCredits=parseAdmissionBigint(parsed.actualCostCredits,'actual_cost_credits');
  const resultDigest=String(parsed.resultDigest);
  if(!HEX64.test(resultDigest)||digestJson(output)!==resultDigest) throw new StoredBatchStorageError('pending_evidence');
  return Object.freeze({output,usageSnapshot,actualCostCredits,resultDigest});
}
function serializePendingEvidence(value:StoredBatchPendingEvidence):Readonly<{parsed:StoredBatchPendingEvidence;json:string}>{
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||Object.keys(value).sort().join(',')!=='actualCostCredits,output,resultDigest,usageSnapshot'
    ||typeof value.actualCostCredits!=='bigint') throw new StoredBatchStorageError('pending_evidence');
  const parsed=parsePendingEvidence({
    output:value.output,usageSnapshot:value.usageSnapshot,
    actualCostCredits:value.actualCostCredits.toString(),resultDigest:value.resultDigest,
  });
  return Object.freeze({parsed,json:JSON.stringify({
    output:parsed.output,usageSnapshot:parsed.usageSnapshot,
    actualCostCredits:parsed.actualCostCredits.toString(),resultDigest:parsed.resultDigest,
  })});
}
function assertCreateArgs(args:CreateStoredBatchArgs):void{
  normalizeAdmissionUuid(args.orgId);
  normalizeAdmissionUuid(args.apiKeyId);
  if(args.contractVersion!==5||args.billingMode!=='stored'||!BATCH_ID.test(args.batchId)
    ||!HEX64.test(args.idempotencyKeyDigest)||!HEX64.test(args.requestFingerprint)
    ||!['chat','embeddings','completions'].includes(args.batchType)
    ||!Array.isArray(args.items)||args.items.length<1||args.items.length>100) throw new StoredBatchStorageError();
  const seen=new Set<string>();
  for(let index=0;index<args.items.length;index++){
    const item=args.items[index]!;
    if(item.index!==index||item.routeKind!==args.batchType||seen.has(item.customId)
      ||!HEX64.test(item.requestFingerprint)||item.execution.status!=='ready') throw new StoredBatchStorageError();
    seen.add(item.customId);
    if(item.execution.admissionArgs.orgId!==args.orgId||item.execution.admissionArgs.apiKeyId!==args.apiKeyId
      ||item.execution.admissionArgs.routeKind!==item.routeKind||item.execution.admissionArgs.billingMode!=='stored')
      throw new StoredBatchStorageError();
    const providerRequest=object(item.execution.providerRequest);
    if(providerRequest.modelId!==item.execution.upstreamModelId
      ||Object.hasOwn(providerRequest,'byokKey')||Object.hasOwn(providerRequest,'egressProxyUrl'))
      throw new StoredBatchStorageError();
  }
}

type BatchDbRow=Record<string,unknown> & {
  id:string; batch_id:string; org_id:string; api_key_id:string|null; type:string;
  derived_status:string; total_count:number|string; completed_count:number|string; failed_count:number|string;
  reconciliation_count:number|string; settled_microcredits:string; contract_version:number|string;
  billing_mode:string|null; idempotency_key_digest:string|null; request_fingerprint:string|null;
  queued_at:string|null; reconcile_after:string|null; terminal_at:string|null; created_at:string; expires_at:string;
};

function batchFromRow(row:BatchDbRow):StoredBatchRead{
  if(!['queued','processing','completed','completed_with_errors','failed','reconciliation_required'].includes(row.derived_status))
    throw new StoredBatchStorageError('status');
  return Object.freeze({
    id:uuid(row.id),batchId:String(row.batch_id),orgId:uuid(row.org_id),
    apiKeyId:row.api_key_id===null?null:uuid(row.api_key_id),batchType:String(row.type),
    status:row.derived_status as StoredBatchStatus,
    totalCount:boundedInt(row.total_count,'total_count'),
    completedCount:boundedInt(row.completed_count,'completed_count'),
    failedCount:boundedInt(row.failed_count,'failed_count'),
    reconciliationCount:boundedInt(row.reconciliation_count,'reconciliation_count'),
    settledMicrocredits:BigInt(String(row.settled_microcredits)),
    contractVersion:boundedInt(row.contract_version,'contract_version'),
    billingMode:nullable(row.billing_mode),idempotencyKeyDigest:nullable(row.idempotency_key_digest),
    requestFingerprint:nullable(row.request_fingerprint),queuedAt:nullable(row.queued_at),
    reconcileAfter:nullable(row.reconcile_after),terminalAt:nullable(row.terminal_at),
    createdAt:String(row.created_at),expiresAt:String(row.expires_at),
  });
}

function readBatchRows(client:SqlClient,orgId:string,batchId:string){
  return client<BatchDbRow[]>`
    WITH counts AS (
      SELECT
        bi.batch_id,
        count(*)::int AS item_total,
        count(*) FILTER (WHERE bi.status='completed')::int AS item_completed,
        count(*) FILTER (WHERE bi.status='failed')::int AS item_failed,
        count(*) FILTER (WHERE bi.status='reconciliation_required')::int AS item_reconciliation,
        count(*) FILTER (WHERE bi.status='processing')::int AS item_processing,
        coalesce(sum(a.actual_cost_credits) FILTER (WHERE a.state='settled'),0)::text AS settled_microcredits
      FROM batch_items bi
      LEFT JOIN gateway_charge_admissions a ON a.billing_request_id=bi.billing_request_id
      GROUP BY bi.batch_id
    )
    SELECT b.id::text,b.batch_id,b.org_id::text,b.api_key_id::text,b.type,
      CASE
        WHEN b.contract_version=5 AND coalesce(c.item_reconciliation,0)>0 THEN 'reconciliation_required'
        WHEN b.contract_version=5 AND coalesce(c.item_total,0)>0 AND c.item_completed=c.item_total THEN 'completed'
        WHEN b.contract_version=5 AND coalesce(c.item_total,0)>0 AND c.item_failed=c.item_total THEN 'failed'
        WHEN b.contract_version=5 AND coalesce(c.item_total,0)>0 AND c.item_completed+c.item_failed=c.item_total THEN 'completed_with_errors'
        WHEN b.contract_version=5 AND b.reconcile_after IS NOT NULL AND b.queued_at IS NULL THEN 'reconciliation_required'
        WHEN b.contract_version=5 AND coalesce(c.item_processing,0)>0 THEN 'processing'
        WHEN b.contract_version=5 THEN 'queued'
        ELSE b.status
      END AS derived_status,
      CASE WHEN b.contract_version=5 THEN coalesce(c.item_total,0) ELSE b.total_count END AS total_count,
      CASE WHEN b.contract_version=5 THEN coalesce(c.item_completed,0) ELSE b.completed_count END AS completed_count,
      CASE WHEN b.contract_version=5 THEN coalesce(c.item_failed,0) ELSE b.failed_count END AS failed_count,
      CASE WHEN b.contract_version=5 THEN coalesce(c.item_reconciliation,0) ELSE 0 END AS reconciliation_count,
      CASE WHEN b.contract_version=5 THEN coalesce(c.settled_microcredits,'0') ELSE '0' END AS settled_microcredits,
      b.contract_version,b.billing_mode,b.idempotency_key_digest,b.request_fingerprint,
      CASE WHEN b.queued_at IS NULL THEN NULL ELSE to_char(b.queued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS queued_at,
      CASE WHEN b.reconcile_after IS NULL THEN NULL ELSE to_char(b.reconcile_after AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS reconcile_after,
      CASE WHEN b.terminal_at IS NULL THEN NULL ELSE to_char(b.terminal_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS terminal_at,
      to_char(b.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
      to_char(b.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
    FROM batches b LEFT JOIN counts c ON c.batch_id=b.id
    WHERE b.org_id=${orgId}::uuid AND b.batch_id=${batchId}
    LIMIT 1`;
}

export async function readStoredBatch(orgId:string,batchId:string,client:SqlClient=defaultSql):Promise<StoredBatchRead|null>{
  const rows=await readBatchRows(client,normalizeAdmissionUuid(orgId),batchId);
  return rows[0]?batchFromRow(rows[0]):null;
}

export async function readStoredBatchResults(
  orgId:string,batchId:string,cursor=-1,limit=10,client:SqlClient=defaultSql,
):Promise<StoredBatchResultPage>{
  const org=normalizeAdmissionUuid(orgId);
  if(!Number.isSafeInteger(cursor)||cursor< -1||!Number.isSafeInteger(limit)||limit<1||limit>10) throw new StoredBatchStorageError();
  const rows=await client<Array<Record<string,unknown>>>`
    SELECT bi.item_index,bi.custom_id,bi.status,bi.output,bi.error_code,
      CASE WHEN a.state='settled' THEN a.actual_cost_credits::text ELSE NULL END AS settled_microcredits
    FROM batch_items bi JOIN batches b ON b.id=bi.batch_id
    LEFT JOIN gateway_charge_admissions a ON a.billing_request_id=bi.billing_request_id
    WHERE b.org_id=${org}::uuid AND b.batch_id=${batchId} AND b.contract_version=5 AND bi.item_index>${cursor}
    ORDER BY bi.item_index LIMIT ${limit+1}`;
  const selected=rows.slice(0,limit).map((r)=>{
    if(!['queued','processing','completed','failed','reconciliation_required'].includes(String(r.status))) throw new StoredBatchStorageError();
    return Object.freeze({
      index:boundedInt(r.item_index,'item_index'),customId:String(r.custom_id),status:String(r.status) as StoredBatchItemStatus,
      output:r.output===null?null:object(r.output),errorCode:nullable(r.error_code),
      settledMicrocredits:r.settled_microcredits===null?null:BigInt(String(r.settled_microcredits)),
    });
  });
  return Object.freeze({items:Object.freeze(selected),nextCursor:rows.length>limit?selected[selected.length-1]!.index:null});
}

function assertHeld(admission:GatewayChargeAdmissionResult,item:StoredBatchPreparedItem,args:CreateStoredBatchArgs):void{
  if(item.execution.status!=='ready'||admission.state!=='held'||!admission.didTransition
    ||admission.billingRequestId!==item.execution.billingRequestId||admission.orgId!==args.orgId
    ||admission.apiKeyId!==args.apiKeyId||admission.routeKind!==item.routeKind
    ||admission.billingMode!=='stored'||admission.modelSlug!==item.execution.admissionArgs.modelSlug
    ||admission.authorizedMaxCredits!==item.execution.admissionArgs.authorizedMaxCredits
    ||!admissionJsonObjectsEqual(admission.quoteSnapshot,item.execution.admissionArgs.quoteSnapshot))
    throw new StoredBatchStorageError('Unconfirmed item admission');
}

export async function createOrReplayStoredBatch(
  args:CreateStoredBatchArgs,client:RootSql=defaultSql,
):Promise<Readonly<{kind:'created'|'replay';batch:StoredBatchRead}>>{
  assertCreateArgs(args);
  const result=await client.begin(async(tx)=>{
    const t=tx as unknown as TransactionClient;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${args.orgId+'|'+args.idempotencyKeyDigest},0))`;
    const existing=await tx<Array<{id:string;batch_id:string;type:string;request_fingerprint:string|null}>>`
      SELECT id::text,batch_id,type,request_fingerprint
      FROM batches
      WHERE org_id=${args.orgId}::uuid AND contract_version=5 AND billing_mode='stored'
        AND idempotency_key_digest=${args.idempotencyKeyDigest}
      LIMIT 1 FOR UPDATE`;
    if(existing[0]){
      if(existing[0].request_fingerprint!==args.requestFingerprint||existing[0].type!==args.batchType)
        throw new StoredBatchConflictError();
      return Object.freeze({kind:'replay' as const,batchId:existing[0].batch_id});
    }

    const parent=await tx<Array<{id:string;batch_id:string}>>`
      INSERT INTO batches(
        batch_id,org_id,api_key_id,type,status,input_file_url,total_count,expires_at,
        contract_version,billing_mode,idempotency_key_digest,request_fingerprint
      ) VALUES(
        ${args.batchId},${args.orgId}::uuid,${args.apiKeyId}::uuid,${args.batchType},'queued',
        ${'inline:'+args.batchId},${args.items.length},${args.expiresAt}::timestamptz,
        5,'stored',${args.idempotencyKeyDigest},${args.requestFingerprint}
      ) RETURNING id::text,batch_id`;
    const parentId=parent[0]?.id;
    if(!parentId) throw new StoredBatchStorageError();

    for(const item of args.items){
      if(item.execution.status!=='ready') throw new StoredBatchStorageError();
      await tx`
        INSERT INTO batch_items(
          batch_id,item_index,custom_id,route_kind,request_fingerprint,request_body,
          billing_request_id,attempt_id,model_slug,model_upstream_id,upstream_id,
          upstream_model_id,adapter_key,pricing_snapshot,provider_request,status,deadline_at
        ) VALUES(
          ${parentId}::uuid,${item.index},${item.customId},${item.routeKind},${item.requestFingerprint},
          ${JSON.stringify(item.requestBody)}::text::jsonb,
          ${item.execution.billingRequestId}::uuid,${item.execution.attemptId}::uuid,
          ${item.execution.admissionArgs.modelSlug},${item.execution.modelUpstreamId}::uuid,
          ${item.execution.upstreamId},${item.execution.upstreamModelId},${item.execution.adapterKey},
          ${JSON.stringify(item.execution.pricingSnapshot)}::text::jsonb,
          ${JSON.stringify(item.execution.providerRequest)}::text::jsonb,'queued',
          ${item.execution.admissionArgs.preDispatchDeadlineAt}::timestamptz
        )`;
    }
    for(const item of args.items){
      if(item.execution.status!=='ready') throw new StoredBatchStorageError();
      const admission=await admitGatewayChargeV2(item.execution.admissionArgs,t);
      assertHeld(admission,item,args);
    }
    return Object.freeze({kind:'created' as const,batchId:args.batchId});
  });
  const batch=await readStoredBatch(args.orgId,result.batchId,client);
  if(!batch) throw new StoredBatchStorageError();
  return Object.freeze({kind:result.kind,batch});
}

type ItemDbRow=Record<string,unknown> & {
  id:string;batch_id:string;opaque_batch_id:string;item_index:number|string;custom_id:string;route_kind:string;
  request_fingerprint:string;request_body:unknown;billing_request_id:string;attempt_id:string;model_slug:string;
  model_upstream_id:string;upstream_id:string;upstream_model_id:string;adapter_key:string;pricing_snapshot:unknown;
  provider_request:unknown;status:string;deadline_at:string;
};

async function loadItemRow(id:string,client:SqlClient):Promise<ItemDbRow|null>{
  const rows=await client<ItemDbRow[]>`
    SELECT bi.id::text,bi.batch_id::text,b.batch_id AS opaque_batch_id,bi.item_index,bi.custom_id,bi.route_kind,
      bi.request_fingerprint,bi.request_body,bi.billing_request_id::text,bi.attempt_id::text,bi.model_slug,
      bi.model_upstream_id::text,bi.upstream_id,bi.upstream_model_id,bi.adapter_key,bi.pricing_snapshot,
      bi.provider_request,bi.status,
      to_char(bi.deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline_at
    FROM batch_items bi JOIN batches b ON b.id=bi.batch_id
    WHERE bi.id=${id}::uuid AND b.contract_version=5 LIMIT 1`;
  return rows[0]??null;
}

async function admissionFor(id:string,client:SqlClient):Promise<GatewayChargeAdmissionResult>{
  const rows=await client<Array<Record<string,unknown>>>`
    WITH admission AS (
      SELECT a.*,false AS did_transition
      FROM gateway_charge_admissions a
      WHERE a.billing_request_id=${id}::uuid
      LIMIT 1
    )
    SELECT ${admissionProjection(client)} FROM admission`;
  if(!rows[0]) throw new StoredBatchStorageError('Missing item admission');
  return parseGatewayChargeAdmissionResult(rows[0]);
}

function workerItem(row:ItemDbRow,admission:GatewayChargeAdmissionResult):StoredBatchWorkerItem{
  if(!['chat','embeddings','completions'].includes(row.route_kind)
    ||!['queued','processing','completed','failed','reconciliation_required'].includes(row.status)) throw new StoredBatchStorageError();
  return Object.freeze({
    id:uuid(row.id),parentId:uuid(row.batch_id),batchId:String(row.opaque_batch_id),
    itemIndex:boundedInt(row.item_index,'item_index'),customId:String(row.custom_id),
    routeKind:row.route_kind as StoredBatchWorkerItem['routeKind'],requestFingerprint:String(row.request_fingerprint),
    requestBody:object(row.request_body),billingRequestId:uuid(row.billing_request_id),attemptId:uuid(row.attempt_id),
    modelSlug:String(row.model_slug),modelUpstreamId:uuid(row.model_upstream_id),upstreamId:String(row.upstream_id),
    upstreamModelId:String(row.upstream_model_id),adapterKey:String(row.adapter_key),pricingSnapshot:object(row.pricing_snapshot),
    providerRequest:object(row.provider_request),
    status:row.status as StoredBatchItemStatus,deadlineAt:String(row.deadline_at),admission,
  });
}

export async function loadStoredBatchItem(id:string,client:SqlClient=defaultSql):Promise<StoredBatchWorkerItem|null>{
  const row=await loadItemRow(normalizeAdmissionUuid(id),client);
  if(!row) return null;
  const admission=await admissionFor(row.billing_request_id,client);
  return workerItem(row,admission);
}

export async function loadStoredBatchPendingEvidence(
  itemId:string,client:SqlClient=defaultSql,
):Promise<StoredBatchPendingEvidence|null>{
  const id=normalizeAdmissionUuid(itemId);
  const rows=await client<Array<{pending_evidence:unknown}>>`
    SELECT pending_evidence FROM batch_items WHERE id=${id}::uuid`;
  if(!rows[0]||rows[0].pending_evidence===null) return null;
  return parsePendingEvidence(rows[0].pending_evidence);
}

export async function recordStoredBatchPendingEvidence(
  itemId:string,evidence:StoredBatchPendingEvidence,client:SqlClient=defaultSql,
):Promise<void>{
  const id=normalizeAdmissionUuid(itemId);
  const serialized=serializePendingEvidence(evidence);
  const rows=await client<Array<{id:string}>>`
    UPDATE batch_items bi SET pending_evidence=${serialized.json}::text::jsonb,updated_at=clock_timestamp()
    FROM gateway_charge_admissions admission
    WHERE bi.id=${id}::uuid AND bi.status='processing' AND bi.pending_evidence IS NULL
      AND admission.billing_request_id=bi.billing_request_id
      AND admission.state='dispatched'
      AND admission.attempt_id=bi.attempt_id
      AND admission.upstream_id=bi.upstream_id
      AND admission.pricing_snapshot=bi.pricing_snapshot
      AND ${serialized.parsed.actualCostCredits.toString()}::bigint<=admission.authorized_max_credits
    RETURNING bi.id::text`;
  if(rows.length) return;
  const current=await loadStoredBatchPendingEvidence(id,client);
  if(!current||current.actualCostCredits!==serialized.parsed.actualCostCredits
    ||current.resultDigest!==serialized.parsed.resultDigest
    ||!admissionJsonObjectsEqual(current.output,serialized.parsed.output)
    ||!admissionJsonObjectsEqual(current.usageSnapshot,serialized.parsed.usageSnapshot))
    throw new StoredBatchConflictError();
}

export async function completeStoredBatchItemFromPendingEvidence(
  itemId:string,settledAt:string,client:SqlClient=defaultSql,
):Promise<void>{
  const id=normalizeAdmissionUuid(itemId);
  const settled=normalizeAdmissionTimestamp(settledAt,'settled_at');
  const rows=await client<Array<{id:string}>>`
    UPDATE batch_items bi SET status='completed',output=bi.pending_evidence->'output',error_code=NULL,
      result_digest=bi.pending_evidence->>'resultDigest',settled_at=admission.settled_at,
      pending_evidence=NULL,updated_at=clock_timestamp()
    FROM gateway_charge_admissions admission
    WHERE bi.id=${id}::uuid AND bi.status IN('processing','reconciliation_required')
      AND bi.pending_evidence IS NOT NULL
      AND admission.billing_request_id=bi.billing_request_id AND admission.state='settled'
      AND admission.attempt_id=bi.attempt_id AND admission.upstream_id=bi.upstream_id
      AND admission.pricing_snapshot=bi.pricing_snapshot
      AND admission.actual_cost_credits::text=bi.pending_evidence->>'actualCostCredits'
      AND admission.usage_snapshot=bi.pending_evidence->'usageSnapshot'
      AND to_char(admission.settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=${settled}
    RETURNING bi.id::text`;
  if(rows.length) return;
  const current=await client<Array<{confirmed:boolean;output:unknown;result_digest:string|null}>>`
    SELECT bi.status='completed' AND bi.pending_evidence IS NULL
      AND to_char(bi.settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=${settled}
      AND admission.state='settled' AND admission.settled_at=bi.settled_at
      AND admission.billing_request_id=bi.billing_request_id
      AND admission.attempt_id=bi.attempt_id AND admission.upstream_id=bi.upstream_id
      AND admission.pricing_snapshot=bi.pricing_snapshot AS confirmed,
      bi.output,bi.result_digest
    FROM batch_items bi JOIN gateway_charge_admissions admission
      ON admission.billing_request_id=bi.billing_request_id
    WHERE bi.id=${id}::uuid`;
  if(!current[0]?.confirmed||current[0].output===null||!current[0].result_digest
    ||digestJson(object(current[0].output))!==current[0].result_digest) throw new StoredBatchConflictError();
}

export async function listStoredBatchEvidenceRecoveryCandidates(
  now:string,limit=100,client:SqlClient=defaultSql,
):Promise<readonly StoredBatchEvidenceRecoveryCandidate[]>{
  const at=normalizeAdmissionTimestamp(now,'now');
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000) throw new StoredBatchStorageError();
  const rows=await client<Array<Record<string,unknown>>>`
    SELECT bi.id::text AS item_id,bi.batch_id::text AS parent_id,b.batch_id,
      bi.billing_request_id::text,admission.state AS admission_state,bi.pending_evidence
    FROM batch_items bi
    JOIN batches b ON b.id=bi.batch_id
    JOIN gateway_charge_admissions admission ON admission.billing_request_id=bi.billing_request_id
    WHERE b.contract_version=5 AND b.terminal_at IS NULL
      AND bi.status IN('processing','reconciliation_required')
      AND (admission.state IN('outcome_recorded','settled')
        OR (admission.state='dispatched' AND bi.pending_evidence IS NOT NULL))
      AND coalesce(admission.settled_at,admission.outcome_recorded_at,bi.updated_at)<=${at}::timestamptz
    ORDER BY coalesce(admission.settled_at,admission.outcome_recorded_at,bi.updated_at),bi.id
    LIMIT ${limit}`;
  return Object.freeze(rows.map((row)=>{
    if(row.admission_state!=='dispatched'&&row.admission_state!=='outcome_recorded'&&row.admission_state!=='settled')
      throw new StoredBatchStorageError();
    return Object.freeze({
      itemId:uuid(row.item_id),parentId:uuid(row.parent_id),batchId:String(row.batch_id),
      billingRequestId:uuid(row.billing_request_id),admissionState:row.admission_state,
      evidence:row.pending_evidence===null?null:parsePendingEvidence(row.pending_evidence),
    });
  }));
}

export async function claimNextStoredBatchItem(
  batchId:string,client:RootSql=defaultSql,
):Promise<StoredBatchWorkerItem|null>{
  const id=await client.begin(async(tx)=>{
    const parents=await tx<Array<{id:string}>>`
      SELECT b.id::text
      FROM batches b
      WHERE b.batch_id=${batchId} AND b.contract_version=5 AND b.terminal_at IS NULL
      LIMIT 1 FOR UPDATE`;
    if(!parents[0]) return null;
    const rows=await tx<Array<{id:string}>>`
      SELECT candidate.id::text
      FROM batch_items candidate
      WHERE candidate.batch_id=${parents[0].id}::uuid
        AND candidate.status='queued'
        AND NOT EXISTS (
          SELECT 1 FROM batch_items active
          WHERE active.batch_id=${parents[0].id}::uuid AND active.status='processing'
        )
      ORDER BY candidate.item_index
      LIMIT 1 FOR UPDATE OF candidate`;
    if(!rows[0]) return null;
    const updated=await tx<Array<{id:string}>>`
      UPDATE batch_items SET status='processing',updated_at=clock_timestamp()
      WHERE id=${rows[0].id}::uuid AND status='queued'
      RETURNING id::text`;
    return updated[0]?.id??null;
  });
  return id?loadStoredBatchItem(id,client):null;
}

export async function releaseStoredBatchItemClaimForRetry(
  itemId:string,retryAt:string,client:RootSql=defaultSql,
):Promise<void>{
  const id=normalizeAdmissionUuid(itemId);
  const retry=normalizeAdmissionTimestamp(retryAt,'retry_at');
  await client.begin(async(tx)=>{
    const owned=await tx<Array<{parent_id:string}>>`
      SELECT bi.batch_id::text AS parent_id
      FROM batch_items bi JOIN batches b ON b.id=bi.batch_id
      WHERE bi.id=${id}::uuid AND b.contract_version=5 AND b.terminal_at IS NULL
      LIMIT 1 FOR UPDATE OF bi,b`;
    if(!owned[0]) throw new StoredBatchConflictError();
    const released=await tx<Array<{id:string}>>`
      UPDATE batch_items bi SET status='queued',updated_at=clock_timestamp()
      WHERE bi.id=${id}::uuid AND bi.status='processing' AND bi.pending_evidence IS NULL
        AND EXISTS(
          SELECT 1 FROM gateway_charge_admissions admission
          WHERE admission.billing_request_id=bi.billing_request_id
            AND admission.state='held' AND admission.attempt_id IS NULL
            AND admission.upstream_id IS NULL AND admission.dispatched_at IS NULL
        )
      RETURNING bi.id::text`;
    if(!released[0]) throw new StoredBatchConflictError();
    const parent=await tx<Array<{id:string}>>`
      UPDATE batches SET status='reconciliation_required',queued_at=NULL,reconcile_after=${retry}::timestamptz
      WHERE id=${owned[0].parent_id}::uuid AND contract_version=5 AND terminal_at IS NULL
      RETURNING id::text`;
    if(!parent[0]) throw new StoredBatchConflictError();
  });
}

export async function reconcileStaleStoredBatchProcessing(
  now:string,graceSeconds=3600,limit=100,client:RootSql=defaultSql,
):Promise<readonly string[]>{
  const at=normalizeAdmissionTimestamp(now,'now');
  if(!Number.isSafeInteger(graceSeconds)||graceSeconds<3600||graceSeconds>604800
    ||!Number.isSafeInteger(limit)||limit<1||limit>1000) throw new StoredBatchStorageError();
  return client.begin(async(tx)=>{
    const candidates=await tx<Array<{id:string;parent_id:string;safe_retry:boolean}>>`
      SELECT bi.id::text,bi.batch_id::text AS parent_id,
        admission.state='held' AND admission.attempt_id IS NULL AND admission.upstream_id IS NULL
          AND admission.dispatched_at IS NULL AND bi.pending_evidence IS NULL AS safe_retry
      FROM batch_items bi JOIN batches b ON b.id=bi.batch_id
      JOIN gateway_charge_admissions admission ON admission.billing_request_id=bi.billing_request_id
      WHERE b.contract_version=5 AND b.terminal_at IS NULL AND bi.status='processing'
        AND bi.updated_at<=${at}::timestamptz-(${graceSeconds}::bigint*interval '1 second')
      ORDER BY bi.updated_at,bi.id LIMIT ${limit} FOR UPDATE OF bi,admission SKIP LOCKED`;
    if(!candidates.length) return Object.freeze([] as string[]);
    const safeIds=candidates.filter((value)=>value.safe_retry).map((value)=>value.id);
    const uncertainIds=candidates.filter((value)=>!value.safe_retry).map((value)=>value.id);
    const updatedIds=new Set<string>();
    if(safeIds.length){
      const released=await tx<Array<{id:string}>>`
        UPDATE batch_items SET status='queued',updated_at=clock_timestamp()
        WHERE id=ANY(${safeIds}::uuid[]) AND status='processing' AND pending_evidence IS NULL
        RETURNING id::text`;
      for(const value of released) updatedIds.add(value.id);
      const safeParents=[...new Set(candidates.filter((value)=>updatedIds.has(value.id)).map((value)=>value.parent_id))];
      if(safeParents.length) await tx`
        UPDATE batches SET status='reconciliation_required',queued_at=NULL,reconcile_after=${at}::timestamptz
        WHERE id=ANY(${safeParents}::uuid[]) AND contract_version=5 AND terminal_at IS NULL`;
    }
    if(uncertainIds.length){
      const uncertain=await tx<Array<{id:string}>>`
      UPDATE batch_items SET status='reconciliation_required',error_code='BATCH_PROCESSING_STALE',
        updated_at=clock_timestamp()
      WHERE id=ANY(${uncertainIds}::uuid[]) AND status='processing'
      RETURNING id::text`;
      for(const value of uncertain) updatedIds.add(value.id);
      const uncertainParents=[...new Set(candidates.filter((value)=>updatedIds.has(value.id)&&!value.safe_retry).map((value)=>value.parent_id))];
      if(uncertainParents.length) await tx`
        UPDATE batches SET status='reconciliation_required',queued_at=NULL,reconcile_after=${at}::timestamptz
        WHERE id=ANY(${uncertainParents}::uuid[]) AND contract_version=5 AND terminal_at IS NULL`;
      for(const parentId of uncertainParents) await refreshStoredBatchAggregate(parentId,tx as unknown as TransactionClient);
    }
    return Object.freeze(candidates.map((value)=>value.id).filter((idValue)=>updatedIds.has(idValue)));
  });
}

export async function markStoredBatchItemTerminal(
  args:Readonly<{
    itemId:string;
    status:'completed'|'failed'|'reconciliation_required';
    output?:JsonObject;
    errorCode?:string;
    resultDigest?:string;
    settledAt?:string;
  }>,
  client:SqlClient=defaultSql,
):Promise<void>{
  const id=normalizeAdmissionUuid(args.itemId);
  const settledAt=args.settledAt===undefined?null:normalizeAdmissionTimestamp(args.settledAt,'settled_at');
  if(args.status==='completed'){
    if(!args.output||!args.resultDigest||!HEX64.test(args.resultDigest)||settledAt===null||args.errorCode) throw new StoredBatchStorageError();
  }else if(!args.errorCode||!ERROR_CODE.test(args.errorCode)||args.output||args.resultDigest) throw new StoredBatchStorageError();
  const parsedOutput=args.output?parseAdmissionJsonObject(args.output):null;
  const output=parsedOutput?JSON.stringify(parsedOutput):null;
  const rows=await client<Array<{id:string}>>`
    UPDATE batch_items SET
      status=${args.status},
      output=${output}::text::jsonb,
      error_code=${args.errorCode??null},
      result_digest=${args.resultDigest??null},
      settled_at=${settledAt}::timestamptz,
      pending_evidence=CASE WHEN ${args.status} IN('completed','failed') THEN NULL ELSE pending_evidence END,
      updated_at=clock_timestamp()
    WHERE id=${id}::uuid AND status IN ('queued','processing')
    RETURNING id::text`;
  if(rows.length) return;
  const current=await client<Array<{
    status:string;error_code:string|null;output_matches:boolean;result_digest_matches:boolean;settled_at_matches:boolean;
  }>>`
    SELECT status,error_code,
      output IS NOT DISTINCT FROM ${output}::text::jsonb AS output_matches,
      result_digest IS NOT DISTINCT FROM ${args.resultDigest??null} AS result_digest_matches,
      settled_at IS NOT DISTINCT FROM ${settledAt}::timestamptz AS settled_at_matches
    FROM batch_items WHERE id=${id}::uuid`;
  if(!current[0]||current[0].status!==args.status) throw new StoredBatchConflictError();
  if(current[0].error_code!==(args.errorCode??null)||!current[0].output_matches
    ||!current[0].result_digest_matches||!current[0].settled_at_matches) throw new StoredBatchConflictError();
}

export async function refreshStoredBatchAggregate(parentId:string,client:SqlClient=defaultSql):Promise<void>{
  const id=normalizeAdmissionUuid(parentId);
  await client`
    WITH s AS (
      SELECT count(*)::int total,
        count(*) FILTER(WHERE status='completed')::int completed,
        count(*) FILTER(WHERE status='failed')::int failed,
        count(*) FILTER(WHERE status='reconciliation_required')::int recon,
        count(*) FILTER(WHERE status='processing')::int processing
      FROM batch_items WHERE batch_id=${id}::uuid
    ), d AS (
      SELECT *,
        CASE
          WHEN recon>0 THEN 'reconciliation_required'
          WHEN total>0 AND completed=total THEN 'completed'
          WHEN total>0 AND failed=total THEN 'failed'
          WHEN total>0 AND completed+failed=total THEN 'completed_with_errors'
          WHEN processing>0 THEN 'processing'
          ELSE 'queued'
        END status
      FROM s
    )
    UPDATE batches b SET
      total_count=d.total,completed_count=d.completed,failed_count=d.failed,status=d.status,
      terminal_at=CASE WHEN d.status IN('completed','completed_with_errors','failed') THEN coalesce(b.terminal_at,clock_timestamp()) ELSE NULL END,
      reconcile_after=CASE WHEN d.status IN('completed','completed_with_errors','failed') THEN NULL ELSE b.reconcile_after END
    FROM d WHERE b.id=${id}::uuid AND b.contract_version=5`;
}

export async function markStoredBatchQueued(
  batchId:string,queuedAt:string,client:SqlClient=defaultSql,
):Promise<void>{
  if(!BATCH_ID.test(batchId)) throw new StoredBatchStorageError();
  const at=normalizeAdmissionTimestamp(queuedAt,'queued_at');
  const rows=await client<Array<{batch_id:string}>>`
    UPDATE batches SET queued_at=${at}::timestamptz,reconcile_after=NULL
    WHERE batch_id=${batchId} AND contract_version=5 AND terminal_at IS NULL AND queued_at IS NULL
    RETURNING batch_id`;
  if(rows.length) return;
  const current=await client<Array<{queued_at:string|null;terminal_at:string|null}>>`
    SELECT CASE WHEN queued_at IS NULL THEN NULL
      ELSE to_char(queued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS queued_at,
      CASE WHEN terminal_at IS NULL THEN NULL ELSE terminal_at::text END AS terminal_at
    FROM batches
    WHERE batch_id=${batchId} AND contract_version=5`;
  if(!current[0]||(current[0].queued_at===null&&current[0].terminal_at===null))
    throw new StoredBatchConflictError();
}

export async function markStoredBatchQueueRecoveryNeeded(
  batchId:string,retryAt:string,client:SqlClient=defaultSql,
):Promise<void>{
  const rows=await client<Array<{batch_id:string}>>`
    UPDATE batches SET status='reconciliation_required',queued_at=NULL,reconcile_after=${retryAt}::timestamptz
    WHERE batch_id=${batchId} AND contract_version=5 AND terminal_at IS NULL
    RETURNING batch_id`;
  if(!rows.length) throw new StoredBatchStorageError();
}

export async function listRecoverableStoredBatches(
  now:string,limit=100,client:SqlClient=defaultSql,
):Promise<readonly string[]>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000) throw new StoredBatchStorageError();
  const rows=await client<Array<{batch_id:string}>>`
    SELECT DISTINCT b.batch_id
    FROM batches b
    WHERE b.contract_version=5 AND b.terminal_at IS NULL
      AND b.queued_at IS NULL
      AND b.reconcile_after IS NOT NULL
      AND b.reconcile_after<=${now}::timestamptz
      AND EXISTS(SELECT 1 FROM batch_items bi WHERE bi.batch_id=b.id AND bi.status='queued')
    ORDER BY b.batch_id LIMIT ${limit}`;
  return Object.freeze(rows.map(row=>String(row.batch_id)));
}

/** Internal worker progress check; public batch reads remain org scoped. */
export async function hasQueuedStoredBatchItems(
  batchId:string,client:SqlClient=defaultSql,
):Promise<boolean>{
  if(!BATCH_ID.test(batchId)) throw new StoredBatchStorageError();
  const rows=await client<Array<{has_queued:boolean}>>`
    SELECT EXISTS(
      SELECT 1 FROM batches b JOIN batch_items bi ON bi.batch_id=b.id
      WHERE b.batch_id=${batchId} AND b.contract_version=5
        AND b.terminal_at IS NULL AND bi.status='queued'
    ) AS has_queued`;
  return rows[0]?.has_queued===true;
}
