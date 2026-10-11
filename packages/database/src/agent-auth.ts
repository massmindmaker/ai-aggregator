/** Agent registration rail: TON-proof challenges → service-owned org + principal. No key custody here. */
import { createHash,randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import { Address } from '@ton/core';
import { parseTonWalletProofInput,verifyTonWalletProof } from '@aiag/shared/server';
import type { TonWalletProofInput,VerifiedTonWallet } from '@aiag/shared/server';
import type { TonPaymentDatabase,TonSqlClient } from './ton-payment-types';

export class AgentAuthError extends Error{constructor(readonly code:string){super(code);this.name='AgentAuthError';}}
export interface AgentChallenge{challengeId:string;payload:string;expiresAt:string;}
export interface AgentRegisterResult{principalId:string;orgId:string;primaryKey?:{id:string;prefix:string};}
/** The caller (gateway) supplies raw `0:hex` Ton Connect addresses; the rail persists the friendly form. */
export interface AgentChallengeInput{address:string;network:'-3';domain:string;}
/**
 * Review wave (T-a1 Fix 2/3): optional FIRST gateway key, minted INSIDE the
 * registration transaction. The gateway generates the plaintext locally and
 * passes only its SHA-256 hash + 20-char prefix + name — the plaintext never
 * enters this package. With this present, "org without its bootstrap key" is
 * unreachable: any failure (including the mint itself) rolls the org,
 * principal and challenge consumption back together, so the wallet can
 * simply register again — the keyless lock-out is closed. The same
 * transaction also enrolls the org into quota v2 (0068), which stored
 * admission requires (QUOTA_V2_NOT_ENABLED would otherwise 500 the agent).
 */
export interface AgentRegisterInput{
 challengeId:string;address:string;proof:unknown;
 primaryKey?:{hash:string;prefix:string;name:string};
}
export interface AgentChallengeRow extends Record<string,unknown>{
 id:string;purpose:'register'|'revoke';payload_hash:string;network:string;address:string;domain:string;issued_ms:string;expires_ms:string;consumed_at:string|null;
}

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function fail(code='AGENT_AUTH_INVALID'):never{throw new AgentAuthError(code);}
function uuid(value:unknown):string{if(typeof value!=='string'||value.length!==36||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))fail();return value;}
function hex64(value:unknown):string{if(typeof value!=='string'||value.length!==64||!/^[0-9a-f]{64}$/.test(value))fail();return value;}
function equalHash(a:string,b:string):boolean{return timingSafeEqual(Buffer.from(hex64(a),'hex'),Buffer.from(hex64(b),'hex'));}
function rawAddress(value:unknown):string{if(typeof value!=='string'||!/^0:[0-9a-f]{64}$/.test(value))fail();return value;}
/** Canonical display form stored in the 48-char columns (matches the web Ton Connect sender encoding). */
function displayAddress(raw:string):string{
 const display=Address.parseRaw(raw).toString({urlSafe:true,bounceable:true,testOnly:true});
 if(!/^[A-Za-z0-9_-]{48}$/.test(display))fail();return display;
}
function domain(value:unknown):string{
 if(typeof value!=='string'||value.length>300||value.length<3||!value.includes('.')||new URL('https://'+value).host!==value)fail();return value;
}
/** gateway_api_keys.key_prefix shape: `sk_aiag_(live|test)_` stem + 7 base64url chars (lib/api-key prefix = key.slice(0,20)). */
const PRIMARY_KEY_PREFIX=/^sk_aiag_(live|test)_[A-Za-z0-9_-]{7}$/;
/** Validate the caller-supplied first-key material BEFORE any SQL: hash = 64 hex, prefix = the gateway stem shape, name = 1..100 chars (gateway_api_keys.name VARCHAR(100)). */
function primaryKeyInput(value:{hash:string;prefix:string;name:string}):{hash:string;prefix:string;name:string}{
 const hash=hex64(value.hash);
 if(typeof value.prefix!=='string'||!PRIMARY_KEY_PREFIX.test(value.prefix))fail();
 const name=typeof value.name==='string'?value.name.trim():'';
 if(name.length===0||name.length>100)fail();
 return {hash,prefix:value.prefix,name};
}
async function query<R extends Record<string,unknown>>(tx:TonSqlClient,text:string,values:readonly unknown[]=[]){return (await tx.query<R>({text,values})).rows;}
async function clock(tx:TonSqlClient):Promise<number>{const row=(await query<{now_ms:string}>(tx,'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms'))[0];const now=Number(row?.now_ms);if(!Number.isSafeInteger(now)||now<0)fail('AGENT_AUTH_UNAVAILABLE');return now;}
function isUniqueActiveAddress(error:unknown):boolean{return typeof error==='object'&&error!==null&&(error as {code?:unknown}).code==='23505'&&(error as {constraint?:unknown}).constraint==='agent_principals_active_address';}

const challengeFields="id::text,purpose,payload_hash,network,address,domain,floor(extract(epoch FROM issued_at)*1000)::text AS issued_ms,floor(extract(epoch FROM expires_at)*1000)::text AS expires_ms,consumed_at::text";

export async function issueAgentChallenge(db:TonPaymentDatabase,input:AgentChallengeInput):Promise<AgentChallenge>{
 if(input.network!=='-3')fail();
 const contextDomain=domain(input.domain);
 const address=displayAddress(rawAddress(input.address));
 const id=randomUUID(),payload='aiag:agent:register:-3:'+randomBytes(32).toString('hex');
 return db.transaction(async tx=>{
  await query(tx,"SELECT pg_advisory_xact_lock(hashtextextended('aiag:agent:challenge-issue',0))");
  const counters=(await query<{global_n:number;address_n:number}>(tx,`SELECT count(*) FILTER(WHERE issued_at>clock_timestamp()-interval '60 seconds')::int AS global_n,
   count(*) FILTER(WHERE address=$1)::int AS address_n
   FROM public.agent_wallet_challenges WHERE issued_at>clock_timestamp()-interval '5 minutes'`,[address]))[0];
  if(!counters||counters.global_n>=200||counters.address_n>=8)fail('AGENT_CHALLENGE_RATE_LIMIT');
  await query(tx,`DELETE FROM public.agent_wallet_challenges WHERE id IN(SELECT id FROM public.agent_wallet_challenges WHERE expires_at<clock_timestamp()-interval '24 hours' ORDER BY expires_at LIMIT 100)`);
  const row=(await query<{expires_at:string}>(tx,`WITH moment AS MATERIALIZED(SELECT date_trunc('milliseconds',clock_timestamp()) AS n)
   INSERT INTO public.agent_wallet_challenges(id,purpose,payload_hash,network,address,domain,issued_at,expires_at)
   SELECT $1::uuid,'register',$2,'-3',$3,$4,n,n+interval '120 seconds' FROM moment RETURNING expires_at::text`,[id,digest(payload),address,contextDomain]))[0];
  if(!row)fail('AGENT_AUTH_UNAVAILABLE');
  return {challengeId:id,payload,expiresAt:row.expires_at};
 });
}

export async function consumeAgentRegister(db:TonPaymentDatabase,input:AgentRegisterInput):Promise<AgentRegisterResult>{
 const challengeId=uuid(input.challengeId);
 let proof:TonWalletProofInput;try{proof=parseTonWalletProofInput(input.proof);}catch{fail('AGENT_PROOF_INVALID');}
 const claimed=rawAddress(input.address);
 const primary=input.primaryKey===undefined?undefined:primaryKeyInput(input.primaryKey);
 return db.transaction(async tx=>{
  const ch=(await query<AgentChallengeRow>(tx,'SELECT '+challengeFields+' FROM public.agent_wallet_challenges WHERE id=$1::uuid FOR UPDATE',[challengeId]))[0];
  if(!ch||ch.purpose!=='register'||ch.network!=='-3'||ch.address!==displayAddress(claimed))fail('AGENT_CHALLENGE_INVALID');
  if(!equalHash(ch.payload_hash,digest(proof.proof.payload)))fail('AGENT_PROOF_INVALID');
  const now=await clock(tx);
  if(now>=Number(ch.expires_ms)||ch.consumed_at)fail('AGENT_CHALLENGE_EXPIRED');
  let identity:VerifiedTonWallet;try{identity=verifyTonWalletProof(proof,{network:'-3',domain:ch.domain,payload:proof.proof.payload,issuedAtMs:Number(ch.issued_ms),expiresAtMs:Number(ch.expires_ms),nowMs:now});}catch{fail('AGENT_PROOF_INVALID');}
  if(identity.address!==claimed)fail('AGENT_PROOF_INVALID');
  await query(tx,"SELECT pg_advisory_xact_lock(hashtextextended('aiag:agent:address:'||$1,0))",[identity.address]);
  if((await query<{id:string}>(tx,"SELECT id::text FROM public.agent_principals WHERE network='-3' AND address=$1 AND status='active'",[ch.address])).length)fail('AGENT_ALREADY_REGISTERED');
  const owner=(await query<{owner:string}>(tx,'SELECT public.aiag_agent_owner_user_v1()::text AS owner'))[0];
  if(!owner||!uuid(owner.owner))fail('AGENT_AUTH_UNAVAILABLE');
  let org:{id:string}|undefined;
  for(let attempt=0;attempt<3&&!org;attempt++)
   org=(await query<{id:string}>(tx,`INSERT INTO public.organizations(slug,name,owner_id)
    VALUES($1,'agent:'||$2,$3::uuid) ON CONFLICT (slug) DO NOTHING RETURNING id::text`,['agent-'+randomUUID().slice(0,8),ch.address.slice(0,8),owner.owner]))[0];
  if(!org)fail('AGENT_AUTH_UNAVAILABLE');
  let principal:{id:string}|undefined;
  try{principal=(await query<{id:string}>(tx,`INSERT INTO public.agent_principals(org_id,network,address,address_raw)
   VALUES($1::uuid,'-3',$2,$3) RETURNING id::text`,[org.id,ch.address,identity.address]))[0];}
  catch(error){if(isUniqueActiveAddress(error))fail('AGENT_ALREADY_REGISTERED');throw error;}
  const updated=(await query<{id:string}>(tx,`WITH moment AS MATERIALIZED(SELECT date_trunc('milliseconds',clock_timestamp()) AS n)
   UPDATE public.agent_wallet_challenges c SET consumed_at=n,proof_digest=$2,principal_id=$3::uuid FROM moment
   WHERE c.id=$1::uuid AND c.consumed_at IS NULL AND c.expires_at>n RETURNING c.id::text`,[challengeId,identity.proofDigest,principal!.id]))[0];
  if(!updated)fail('AGENT_CHALLENGE_EXPIRED');
  let minted:{id:string;prefix:string}|undefined;
  if(primary){
   try{
    const key=(await query<{id:string;key_prefix:string}>(tx,`INSERT INTO public.gateway_api_keys(org_id,name,key_hash,key_prefix,policies,rpm_limit,batch_rpm_limit,cost_limit_monthly_rub,model_whitelist,ru_residency_only,expires_at)
     VALUES($1::uuid,$2,$3,$4,'{"kind":"agent","s2s_key_minting":true}'::jsonb,60,10,NULL::numeric,'[]'::jsonb,false,NULL::timestamptz)
     RETURNING id::text,key_prefix`,[org.id,primary.name,primary.hash,primary.prefix]))[0];
    if(!key)fail('AGENT_AUTH_UNAVAILABLE');
    await query(tx,`INSERT INTO public.gateway_quota_org_policies(org_id,enforcement_version) VALUES($1::uuid,2) ON CONFLICT (org_id) DO NOTHING`,[org.id]);
    await query(tx,`INSERT INTO public.usage_events(org_id,api_key_id,request_id,kind,payload)
     VALUES($1::uuid,$2::uuid,NULL,'gateway_key_minted',$3::jsonb)`,[org.id,key.id,JSON.stringify({minted_key_id:key.id,key_prefix:key.key_prefix,name:primary.name,minted_by:'agent_register_bootstrap'})]);
    minted={id:key.id,prefix:key.key_prefix};
   }catch(error){
    if(error instanceof AgentAuthError)throw error;
    // The mint is part of the registration contract: a failed INSERT fails
    // the WHOLE transaction (org + principal roll back with it — the wallet
    // can register again) and surfaces as one retryable 503-grade code, with
    // no driver text escaping.
    fail('AGENT_AUTH_UNAVAILABLE');
   }
  }
  await query(tx,`INSERT INTO public.audit_log(actor_id,actor_type,action,resource_type,resource_id,details)
   VALUES($1::uuid,'system','agent.register','agent_principal',$2,$3::jsonb)`,[owner.owner,principal!.id,JSON.stringify({challengeId,network:'-3',orgId:org.id})]);
  return minted?{principalId:principal!.id,orgId:org.id,primaryKey:minted}:{principalId:principal!.id,orgId:org.id};
 });
}

// ── Principal self-revoke (0107 aiag_revoke_agent_principal_v1, Task 7) ───────
export interface AgentRevokeInput{keyId:string}
export interface AgentRevokeResult{principalId:string;revokedAt:string;keysRevoked:number}

/** RAISE EXCEPTION codes the 0107 entrypoint can surface as the driver message. */
const REVOKE_SQL_CODES=new Set(['AGENT_NOT_AUTHORIZED','AGENT_PRINCIPAL_STATE_CONFLICT']);

const ISO_LIKE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function rethrowRevokeSqlError(e:unknown):never{
 if(e instanceof AgentAuthError)throw e;
 const message=typeof e==='object'&&e!==null?String((e as{message?:unknown}).message):'';
 if(REVOKE_SQL_CODES.has(message))fail(message);
 throw e;
}

/**
 * Revoke the principal behind the calling key plus every live key of its org
 * (spec §3 C1: the wallet is freed for a fresh registration). Authorization
 * is possession of the live key itself — see the 0107 header. Idempotent: an
 * already-revoked principal returns the stored fact, keysRevoked counting
 * only the keys killed by this call.
 */
export async function revokeAgentPrincipal(db:TonPaymentDatabase,input:AgentRevokeInput):Promise<AgentRevokeResult>{
 const keyId=uuid(input.keyId);
 return db.transaction(async tx=>{
  let raw:unknown;
  try{
   raw=(await query<{result:unknown}>(tx,'SELECT public.aiag_revoke_agent_principal_v1($1::uuid) AS result',[keyId]))[0]?.result;
  }catch(e){rethrowRevokeSqlError(e);}
  // node-pg parses JSONB columns; a string is accepted defensively but any
  // other shape is an unavailable rail, never a 500 with internals.
  let parsed:Record<string,unknown>|undefined;
  if(typeof raw==='string'){try{parsed=JSON.parse(raw)as Record<string,unknown>;}catch{/* fall through */}}
  else if(typeof raw==='object'&&raw!==null&&!Array.isArray(raw))parsed=raw as Record<string,unknown>;
  // Every malformed RESULT shape is one rail failure: the entrypoint is our
  // own 0107 SQL, so a bad shape there is unavailability, not caller error
  // (a bad CALLER input — the key id — already failed above as AUTH_INVALID).
  let principalId:string;
  try{principalId=uuid(parsed?.principalId);}catch{fail('AGENT_REVOKE_UNAVAILABLE');}
  const revokedRaw=parsed?.revokedAt;
  if(typeof revokedRaw!=='string'||!ISO_LIKE.test(revokedRaw)||!Number.isSafeInteger(Date.parse(revokedRaw)))fail('AGENT_REVOKE_UNAVAILABLE');
  const keysRevoked=parsed?.keysRevoked;
  if(typeof keysRevoked!=='number'||!Number.isSafeInteger(keysRevoked)||keysRevoked<0||keysRevoked>100000)fail('AGENT_REVOKE_UNAVAILABLE');
  return {principalId,revokedAt:new Date(revokedRaw).toISOString(),keysRevoked};
 });
}
