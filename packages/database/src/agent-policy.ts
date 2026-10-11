/**
 * Agent routing-policy and quota self-service (plan 2026-10-09 agentic-rail,
 * Task 8). Thin assembly layer over the 0108 SQL writers plus the policy
 * read, mirroring the agent-auth/agent-topup seam contract:
 *  - authorization lives in SQL (live key -> active principal, 0106/0107
 *    predicate); this module only validates the 0108 output shape so a
 *    malformed rail is an availability error, never a 500 with internals;
 *  - every statement is a prepared {text, values} call on the injected
 *    TonPaymentDatabase — no interpolation, no monetary arithmetic here;
 *  - quota values cross as decimal strings (bigint-safe); null means "clear
 *    the limit" and the caller's patch uses undefined for "leave unchanged";
 *  - updateAgentPolicy resolves absent quota fields from the row it just
 *    locked FOR UPDATE, so a PATCH touching only one limit cannot race a
 *    concurrent PATCH into rewriting the other with a stale value.
 */
import type { TonPaymentDatabase, TonSqlClient } from './ton-payment-types';

export class AgentPolicyError extends Error{constructor(readonly code:string){super(code);this.name='AgentPolicyError';}}

/** PUT-mergeable routing keys (engine.ts ApiKeyPolicies minus the legacy cap and streaming, which stay dashboard-owned). */
export type AgentRoutingKey='default_mode'|'allowed_providers'|'blocked_providers'|'forbid_non_ru'|'allow_pii_transborder';
const ROUTING_KEYS:readonly AgentRoutingKey[]=['default_mode','allowed_providers','blocked_providers','forbid_non_ru','allow_pii_transborder'];

/** Request patch; undefined = leave unchanged, null = remove/clear. */
export interface AgentPolicyPatch{
 default_mode?:string|null;
 allowed_providers?:string[]|null;
 blocked_providers?:string[]|null;
 forbid_non_ru?:boolean|null;
 allow_pii_transborder?:boolean|null;
 model_whitelist?:string[]|null;
 /** Session microcredit limit (micro). */
 session_micro_limit?:string|null;
 /** Monthly limit in CREDITS (1 credit = 1000 micro; the 0061 unit of gateway_api_keys.cost_limit_monthly_rub). */
 monthly_credits_limit?:string|null;
 daily_org_usd_micro_limit?:string|null;
}
export interface AgentPolicyQuotas{sessionMicrocredits:string|null;monthlyCredits:string|null;dailyOrgUsdMicro:string|null;}
export interface AgentPolicyState{orgId:string;policies:Record<string,unknown>;modelWhitelist:string[];quotas:AgentPolicyQuotas;}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fail(code='AGENT_POLICY_INVALID'):never{throw new AgentPolicyError(code);}
function uuid(value:unknown):string{if(typeof value!=='string'||!UUID.test(value))fail();return value;}
function plainObject(value:unknown):Record<string,unknown>{
 if(typeof value!=='object'||value===null||Array.isArray(value))fail('AGENT_POLICY_UNAVAILABLE');
 return value as Record<string,unknown>;
}
function stringArray(value:unknown):string[]{
 if(!Array.isArray(value)||value.some(entry=>typeof entry!=='string'))fail('AGENT_POLICY_UNAVAILABLE');
 return value as string[];
}
/** Trimmed, deduped, non-empty string list — the trust boundary for jsonb array policy values. */
function canonicalStrings(value:readonly string[]):string[]{
 const out:string[]=[];
 for(const entry of value){
  const slug=entry.trim();
  if(slug.length===0||slug.length>128)fail();
  if(!out.includes(slug))out.push(slug);
 }
 return out;
}
/** Numeric string or null — how bigint quota columns cross this seam. Missing is NOT null: it is a malformed rail. */
function numericOrNull(value:unknown):string|null{
 if(value===null)return null;
 if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value))fail('AGENT_POLICY_UNAVAILABLE');
 return value;
}
async function query<R extends Record<string,unknown>>(tx:TonSqlClient,text:string,values:readonly unknown[]=[]){return (await tx.query<R>({text,values})).rows;}

const POLICY_ROW_SQL=`SELECT k.org_id::text AS org_id,k.policies,k.model_whitelist,
 k.cost_limit_monthly_rub::text AS monthly_credits,
 q.session_microcredits_limit_v2::text AS session_micro,
 o.daily_supplier_usd_micro_limit_v2::text AS daily_org_usd_micro
 FROM public.gateway_api_keys k
 LEFT JOIN public.gateway_quota_key_policies q ON q.api_key_id=k.id
 LEFT JOIN public.gateway_quota_org_policies o ON o.org_id=k.org_id`;

/** Live key + active principal (0106/0107 predicate) — the read's whole WHERE. */
const POLICY_ROW_WHERE=` WHERE k.id=$1::uuid AND k.revoked_at IS NULL AND k.disabled_at IS NULL
 AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())
 AND EXISTS(SELECT 1 FROM public.agent_principals p WHERE p.org_id=k.org_id AND p.status='active')`;

interface PolicyRow extends Record<string,unknown>{
 org_id:unknown;policies:unknown;model_whitelist:unknown;monthly_credits:unknown;session_micro:unknown;daily_org_usd_micro:unknown;
}

function rowToState(row:PolicyRow|undefined):AgentPolicyState{
 if(!row)fail('AGENT_NOT_AUTHORIZED');
 return {
  orgId:uuid(row.org_id),
  policies:plainObject(row.policies),
  modelWhitelist:stringArray(row.model_whitelist),
  quotas:{
   sessionMicrocredits:numericOrNull(row.session_micro),
   monthlyCredits:numericOrNull(row.monthly_credits),
   dailyOrgUsdMicro:numericOrNull(row.daily_org_usd_micro),
  },
 };
}

/** Routing-patch merge onto the CURRENT policies: unknown existing keys (kind, s2s_key_minting, ...) are preserved untouched. */
export function mergeKeyPolicies(current:Record<string,unknown>,patch:AgentPolicyPatch):Record<string,unknown>{
 const merged:Record<string,unknown>={...current};
 for(const key of ROUTING_KEYS){
  const value:unknown=patch[key];
  if(value===undefined)continue;
  if(value===null){delete merged[key];continue;}
  if(key==='default_mode'){
   if(value!=='auto'&&value!=='fastest'&&value!=='cheapest'&&value!=='balanced'&&value!=='ru-only')fail();
   merged[key]=value;
  }else if(key==='allowed_providers'||key==='blocked_providers'){
   if(!Array.isArray(value)||value.some(entry=>typeof entry!=='string'))fail();
   merged[key]=canonicalStrings(value);
  }else{
   if(typeof value!=='boolean')fail();
   merged[key]=value;
  }
 }
 return merged;
}

/** Read the calling key's routing policy + quota register (GET /v1/agent/policy). */
export async function readAgentPolicy(db:TonPaymentDatabase,input:{keyId:string}):Promise<AgentPolicyState>{
 const keyId=uuid(input.keyId);
 return db.transaction(async tx=>{
  const row=(await query<PolicyRow>(tx,POLICY_ROW_SQL+POLICY_ROW_WHERE,[keyId]))[0];
  return rowToState(row);
 });
}

/** RAISE EXCEPTION codes the 0108 entrypoints surface as the driver message. */
const POLICY_SQL_CODES=new Set(['AGENT_NOT_AUTHORIZED','AGENT_QUOTA_OUT_OF_RANGE']);

function rethrowSqlError(e:unknown):never{
 if(e instanceof AgentPolicyError)throw e;
 const message=typeof e==='object'&&e!==null?String((e as{message?:unknown}).message):'';
 if(POLICY_SQL_CODES.has(message))fail(message);
 throw e;
}

function quotaResult(raw:unknown):Record<string,unknown>{
 let parsed:Record<string,unknown>|undefined;
 if(typeof raw==='string'){try{parsed=JSON.parse(raw)as Record<string,unknown>;}catch{/* fall through */}}
 else if(typeof raw==='object'&&raw!==null&&!Array.isArray(raw))parsed=raw as Record<string,unknown>;
 if(!parsed)fail('AGENT_POLICY_UNAVAILABLE');
 return parsed;
}

/**
 * Apply a PATCH to the calling key's routing policy / quotas in ONE
 * transaction (PUT /v1/agent/policy). Routing fields and model_whitelist
 * merge onto gateway_api_keys.policies (guarded UPDATE scoped to the locked
 * row's own org and liveness); quota fields go through the 0108 SQL writers
 * with absent-but-untouched limits resolved from that same locked row.
 */
export async function updateAgentPolicy(db:TonPaymentDatabase,input:{keyId:string;patch:AgentPolicyPatch}):Promise<AgentPolicyState>{
 const keyId=uuid(input.keyId);
 const patch=input.patch;
 return db.transaction(async tx=>{
  const current=rowToState((await query<PolicyRow>(tx,POLICY_ROW_SQL+POLICY_ROW_WHERE+' FOR UPDATE OF k',[keyId]))[0]);

  const hasRouting=ROUTING_KEYS.some(key=>patch[key]!==undefined)||patch.model_whitelist!==undefined;
  let policies=current.policies;
  let whitelist=current.modelWhitelist;
  if(hasRouting){
   policies=mergeKeyPolicies(policies,patch);
   if(patch.model_whitelist!==undefined)whitelist=patch.model_whitelist===null?[]:canonicalStrings(patch.model_whitelist);
   const updated=await tx.query<Record<string,unknown>>({text:`UPDATE public.gateway_api_keys
    SET policies=$3::jsonb, model_whitelist=$4::jsonb
    WHERE id=$1::uuid AND org_id=$2::uuid AND revoked_at IS NULL AND disabled_at IS NULL`,
    values:[keyId,current.orgId,JSON.stringify(policies),JSON.stringify(whitelist)]});
   if(updated.rowCount!==1)fail('AGENT_NOT_AUTHORIZED');
   const routingKeys=Object.keys(patch).filter(key=>key!=='session_micro_limit'&&key!=='monthly_credits_limit'&&key!=='daily_org_usd_micro_limit');
   await query(tx,`INSERT INTO public.usage_events (org_id,api_key_id,request_id,kind,payload)
    VALUES($1::uuid,$2::uuid,NULL,'gateway_key_policy_updated',$3::jsonb)`,
    [current.orgId,keyId,JSON.stringify({updated_by_key_id:keyId,routing_keys:routingKeys,model_whitelist:whitelist})]);
  }

  let quotas=current.quotas;
  if(patch.session_micro_limit!==undefined||patch.monthly_credits_limit!==undefined){
   const session=patch.session_micro_limit!==undefined?patch.session_micro_limit:current.quotas.sessionMicrocredits;
   const monthly=patch.monthly_credits_limit!==undefined?patch.monthly_credits_limit:current.quotas.monthlyCredits;
   let raw:unknown;
   try{
    raw=(await query<{result:unknown}>(tx,'SELECT public.aiag_set_agent_key_quota_v1($1::uuid,$2::bigint,$3::bigint) AS result',[keyId,session,monthly]))[0]?.result;
   }catch(e){rethrowSqlError(e);}
   const parsed=quotaResult(raw);
   quotas={...quotas,
    sessionMicrocredits:numericOrNull(parsed.sessionMicrocreditsLimit),
    monthlyCredits:numericOrNull(parsed.monthlyCreditsLimit)};
  }
  if(patch.daily_org_usd_micro_limit!==undefined){
   let raw:unknown;
   try{
    raw=(await query<{result:unknown}>(tx,'SELECT public.aiag_set_agent_org_quota_v1($1::uuid,$2::bigint) AS result',
     [current.orgId,patch.daily_org_usd_micro_limit]))[0]?.result;
   }catch(e){rethrowSqlError(e);}
   const parsed=quotaResult(raw);
   if(parsed.enforcementVersion!=='1'&&parsed.enforcementVersion!=='2')fail('AGENT_POLICY_UNAVAILABLE');
   quotas={...quotas,dailyOrgUsdMicro:numericOrNull(parsed.dailySupplierUsdMicroLimit)};
  }
  return {orgId:current.orgId,policies,modelWhitelist:whitelist,quotas};
 });
}
