import { sql as defaultSql, type SqlClient } from '../lib/db';
import type { StoredMediaHttpIdentity } from './stored-media-http-identity';

export type MediaJobClaim = Readonly<{ id:string; taskId:string; billingRequestId:string; didClaim:boolean }>;
export type MediaJobRead = Readonly<{
  id:string; taskId:string; billingRequestId:string; routeKind:'image'|'video'|'audio_speech';
  status:'claimed'|'queued'|'processing'|'completed'|'failed'; modelSlug:string; upstreamId:string;
  providerFamily:'image'|'video'|'suno'; providerTaskId:string|null; output:unknown; errorMessage:string|null;
  quotedRetailMicrocredits:bigint; quotedSupplierMicrocredits:bigint; deadlineAt:string; settledAt:string|null;
}>;
function uuid(v:unknown):string { if(typeof v!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) throw new Error('MEDIA_JOB_STORAGE_UNAVAILABLE'); return v; }
function one(rows:unknown):Record<string,unknown>{if(!Array.isArray(rows)||rows.length!==1||!rows[0]||typeof rows[0]!=='object')throw new Error('MEDIA_JOB_STORAGE_UNAVAILABLE');return rows[0] as Record<string,unknown>;}
export async function claimMediaJob(args:Readonly<{
 identity:StoredMediaHttpIdentity; orgId:string; apiKeyId:string; billingRequestId:string; taskId:string;
 modelSlug:string; upstreamId:string; modelUpstreamId:string; providerFamily:'image'|'video'|'suno';
 retailMaxMicrocredits:bigint; supplierMaxMicrocredits:bigint; deadlineAt:string; input:Readonly<Record<string,unknown>>;
}>,client:SqlClient=defaultSql):Promise<MediaJobClaim>{
 const r=one(await client`SELECT * FROM aiag_claim_media_job_v1(${args.orgId}::uuid,${args.apiKeyId}::uuid,${args.billingRequestId}::uuid,${args.taskId}::varchar,${args.identity.routeKind}::varchar,${args.identity.idempotencyKeyDigest}::text,${args.identity.requestFingerprint}::text,${args.modelSlug}::varchar,${args.upstreamId}::varchar,${args.modelUpstreamId}::uuid,${args.providerFamily}::varchar,${args.retailMaxMicrocredits.toString()}::bigint,${args.supplierMaxMicrocredits.toString()}::bigint,${args.deadlineAt}::timestamptz,${JSON.stringify(args.input)}::jsonb)`);
 return Object.freeze({id:uuid(r.id),taskId:String(r.task_id),billingRequestId:uuid(r.billing_request_id),didClaim:r.did_claim===true});
}
export async function attachMediaProviderTask(args:Readonly<{orgId:string;jobId:string;billingRequestId:string;providerTaskId:string}>,client:SqlClient=defaultSql):Promise<void>{
 one(await client`SELECT * FROM aiag_attach_media_provider_task_v1(${args.orgId}::uuid,${args.jobId}::uuid,${args.billingRequestId}::uuid,${args.providerTaskId}::varchar)`);
}
export async function readMediaJob(orgId:string,taskId:string,client:SqlClient=defaultSql):Promise<MediaJobRead|null>{
 const rows=await client`SELECT id::text,task_id,billing_request_id::text,route_kind,status,model_slug,upstream_id,provider_family,provider_task_id,output,error_message,quoted_retail_microcredits::text,quoted_supplier_microcredits::text,to_char(deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') deadline_at,CASE WHEN settled_at IS NULL THEN NULL ELSE to_char(settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END settled_at FROM aiag_read_media_job_v1(${orgId}::uuid,${taskId}::varchar)`;
 if(!Array.isArray(rows)||rows.length===0)return null; const r=one(rows);
 return Object.freeze({id:uuid(r.id),taskId:String(r.task_id),billingRequestId:uuid(r.billing_request_id),routeKind:r.route_kind as MediaJobRead['routeKind'],status:r.status as MediaJobRead['status'],modelSlug:String(r.model_slug),upstreamId:String(r.upstream_id),providerFamily:r.provider_family as MediaJobRead['providerFamily'],providerTaskId:r.provider_task_id===null?null:String(r.provider_task_id),output:r.output,errorMessage:r.error_message===null?null:String(r.error_message),quotedRetailMicrocredits:BigInt(String(r.quoted_retail_microcredits)),quotedSupplierMicrocredits:BigInt(String(r.quoted_supplier_microcredits)),deadlineAt:String(r.deadline_at),settledAt:r.settled_at===null?null:String(r.settled_at)});
}
