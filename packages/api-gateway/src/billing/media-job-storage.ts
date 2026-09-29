import { sql as defaultSql, type SqlClient } from '../lib/db';
import { AiagError } from '../lib/errors';
import type { StoredMediaHttpIdentity } from './stored-media-http-identity';
import type { StoredTranscriptionHttpIdentity } from './stored-transcription-http-identity';

export class MediaJobStorageUnavailableError extends AiagError {
  constructor(){ super('MEDIA_JOB_STORAGE_UNAVAILABLE',503,'Media job storage unavailable'); }
}
export class MediaJobIdempotencyConflictError extends AiagError {
  constructor(){ super('MEDIA_IDEMPOTENCY_CONFLICT',409,'Media idempotency conflict'); }
}
function mapped(error:unknown):AiagError {
  const code=error&&typeof error==='object'&&'code' in error?(error as {code?:unknown}).code:undefined;
  const message=error instanceof Error?error.message:undefined;
  if(code==='P0005'&&message==='MEDIA_IDENTITY_CONFLICT') return new MediaJobIdempotencyConflictError();
  if(error instanceof AiagError) return error;
  return new MediaJobStorageUnavailableError();
}

export type MediaJobClaim = Readonly<{ id:string; taskId:string; billingRequestId:string; didClaim:boolean }>;
export type MediaJobRead = Readonly<{
  id:string; taskId:string; billingRequestId:string; routeKind:'image'|'video'|'audio_speech'|'audio_transcription';
  status:'claimed'|'queued'|'processing'|'completed'|'failed'; modelSlug:string; upstreamId:string;
  providerFamily:'image'|'video'|'suno'|'groq_stt'; providerTaskId:string|null; output:unknown; errorMessage:string|null;
  quotedRetailMicrocredits:bigint; quotedSupplierMicrocredits:bigint; deadlineAt:string; settledAt:string|null;
}>;
function uuid(v:unknown):string { if(typeof v!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) throw new Error('MEDIA_JOB_STORAGE_UNAVAILABLE'); return v; }
function one(rows:unknown):Record<string,unknown>{if(!Array.isArray(rows)||rows.length!==1||!rows[0]||typeof rows[0]!=='object')throw new Error('MEDIA_JOB_STORAGE_UNAVAILABLE');return rows[0] as Record<string,unknown>;}
export async function claimMediaJob(args:Readonly<{
 identity:StoredMediaHttpIdentity|StoredTranscriptionHttpIdentity; orgId:string; apiKeyId:string; billingRequestId:string; taskId:string;
 modelSlug:string; upstreamId:string; modelUpstreamId:string; providerFamily:'image'|'video'|'suno'|'groq_stt';
 retailMaxMicrocredits:bigint; supplierMaxMicrocredits:bigint; deadlineAt:string; input:Readonly<Record<string,unknown>>;
}>,client:SqlClient=defaultSql):Promise<MediaJobClaim>{
 try{
  const r=one(await client`SELECT * FROM aiag_claim_media_job_v1(${args.orgId}::uuid,${args.apiKeyId}::uuid,${args.billingRequestId}::uuid,${args.taskId}::varchar,${args.identity.routeKind}::varchar,${args.identity.idempotencyKeyDigest}::text,${args.identity.requestFingerprint}::text,${args.modelSlug}::varchar,${args.upstreamId}::varchar,${args.modelUpstreamId}::uuid,${args.providerFamily}::varchar,${args.retailMaxMicrocredits.toString()}::bigint,${args.supplierMaxMicrocredits.toString()}::bigint,${args.deadlineAt}::timestamptz,${JSON.stringify(args.input)}::text::jsonb)`);
  return Object.freeze({id:uuid(r.id),taskId:String(r.task_id),billingRequestId:uuid(r.billing_request_id),didClaim:r.did_claim===true});
 }catch(error){throw mapped(error);}
}
export async function releaseUnadmittedMediaClaim(args:Readonly<{orgId:string;jobId:string;billingRequestId:string}>,client:SqlClient=defaultSql):Promise<boolean>{
 try{
  const rows=await client`
   WITH org_lock AS (
    SELECT id FROM organizations WHERE id=${args.orgId}::uuid FOR UPDATE
   ), deleted AS (
    DELETE FROM prediction_jobs p USING org_lock
     WHERE p.id=${args.jobId}::uuid
       AND p.org_id=${args.orgId}::uuid
       AND p.billing_request_id=${args.billingRequestId}::uuid
       AND p.contract_version=4
       AND p.status='claimed'
       AND p.provider_task_id IS NULL
       AND NOT EXISTS (
        SELECT 1 FROM gateway_charge_admissions a WHERE a.billing_request_id=p.billing_request_id
       )
     RETURNING p.id::text AS id
   )
   SELECT id FROM deleted`;
  if(!Array.isArray(rows)||rows.length>1)throw new MediaJobStorageUnavailableError();
  return rows.length===1;
 }catch(error){
  if(error instanceof AiagError)throw error;
  throw new MediaJobStorageUnavailableError();
 }
}

export async function attachMediaProviderTask(args:Readonly<{orgId:string;jobId:string;billingRequestId:string;providerTaskId:string}>,client:SqlClient=defaultSql):Promise<void>{
 one(await client`SELECT * FROM aiag_attach_media_provider_task_v1(${args.orgId}::uuid,${args.jobId}::uuid,${args.billingRequestId}::uuid,${args.providerTaskId}::varchar)`);
}
export async function recordSyncTranscriptionResult(
 args:Readonly<{orgId:string;jobId:string;billingRequestId:string;output:Readonly<{text:string}>}>,
 client:SqlClient=defaultSql,
):Promise<Readonly<{state:'dispatched'|'outcome_recorded'|'settled';didRecord:boolean}>>{
 try{
  if(typeof args.output.text!=='string'||Buffer.byteLength(args.output.text,'utf8')>1_000_000)
   throw new MediaJobStorageUnavailableError();
  const r=one(await client`SELECT * FROM aiag_record_sync_transcription_result_v1(
   ${args.orgId}::uuid,${args.jobId}::uuid,${args.billingRequestId}::uuid,
   ${JSON.stringify(args.output)}::text::jsonb)`);
  if(!['dispatched','outcome_recorded','settled'].includes(String(r.state))||typeof r.did_record!=='boolean')
   throw new MediaJobStorageUnavailableError();
  return Object.freeze({state:String(r.state) as 'dispatched'|'outcome_recorded'|'settled',didRecord:r.did_record});
 }catch(error){throw mapped(error);}
}

export async function readMediaJob(orgId:string,taskId:string,client:SqlClient=defaultSql):Promise<MediaJobRead|null>{
 const rows=await client`SELECT id::text,task_id,billing_request_id::text,route_kind,status,model_slug,upstream_id,provider_family,provider_task_id,output,error_message,quoted_retail_microcredits::text,quoted_supplier_microcredits::text,to_char(deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') deadline_at,CASE WHEN settled_at IS NULL THEN NULL ELSE to_char(settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END settled_at FROM aiag_read_media_job_v1(${orgId}::uuid,${taskId}::varchar)`;
 if(!Array.isArray(rows)||rows.length===0)return null; const r=one(rows);
 return Object.freeze({id:uuid(r.id),taskId:String(r.task_id),billingRequestId:uuid(r.billing_request_id),routeKind:r.route_kind as MediaJobRead['routeKind'],status:r.status as MediaJobRead['status'],modelSlug:String(r.model_slug),upstreamId:String(r.upstream_id),providerFamily:r.provider_family as MediaJobRead['providerFamily'],providerTaskId:r.provider_task_id===null?null:String(r.provider_task_id),output:r.output,errorMessage:r.error_message===null?null:String(r.error_message),quotedRetailMicrocredits:BigInt(String(r.quoted_retail_microcredits)),quotedSupplierMicrocredits:BigInt(String(r.quoted_supplier_microcredits)),deadlineAt:String(r.deadline_at),settledAt:r.settled_at===null?null:String(r.settled_at)});
}
