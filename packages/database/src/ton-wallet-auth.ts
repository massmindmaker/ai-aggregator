/** Existing-account TON credentials; pure proof plus transactional state, no wallet/network/payment calls. */
import { randomBytes,randomUUID,createHash,timingSafeEqual } from 'node:crypto';
import { parseTonWalletProofInput,verifyTonWalletProof } from '@aiag/shared/server';
import type { TonPaymentDatabase,TonSqlClient } from './ton-payment-types';
export interface TonWalletContext{purpose:'link'|'login';actorUserId:string|null;browserHash:string;domain:string;}
export interface LinkedTonWallet{id:string;address:string;network:'-3';publicKey:string;walletVersion:'v4r2'|'v5r1';createdAt:string;}
export interface TonWalletLoginUser{id:string;email:string;name:string|null;image:string|null;tonWalletId:string;}
export class TonWalletAuthError extends Error {constructor(readonly code:string){super(code);this.name='TonWalletAuthError';}}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
function fail(code='TON_WALLET_AUTH_INVALID'):never{throw new TonWalletAuthError(code);}
function uuid(v:unknown):string{if(typeof v!=='string'||v.length!==36||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v))fail();return v;}
function hex(v:unknown):string{if(typeof v!=='string'||v.length!==64||!/^[a-f0-9]{64}$/.test(v))fail();return v;}
function equalHash(a:string,b:string):boolean{return timingSafeEqual(Buffer.from(hex(a),'hex'),Buffer.from(hex(b),'hex'));}
function context(v:TonWalletContext):TonWalletContext{
 if(!v||!['link','login'].includes(v.purpose)||typeof v.domain!=='string'||v.domain.length>300||!v.domain.includes('.')||new URL('https://'+v.domain).host!==v.domain)fail();
 hex(v.browserHash);if(v.purpose==='link')uuid(v.actorUserId);else if(v.actorUserId!==null)fail();return v;
}
async function query<R extends Record<string,unknown>>(tx:TonSqlClient,text:string,values:readonly unknown[]=[]){return (await tx.query<R>({text,values})).rows;}
async function clock(tx:TonSqlClient):Promise<number>{const row=(await query<{now_ms:string}>(tx,'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms'))[0];const now=Number(row?.now_ms);if(!Number.isSafeInteger(now)||now<0)fail('TON_WALLET_AUTH_UNAVAILABLE');return now;}
async function active(tx:TonSqlClient,id:string){
 const row=(await query<{id:string;email:string;name:string|null;image:string|null;password_hash:string|null}>(tx,'SELECT id::text,email,name,image,password_hash FROM public.users WHERE id=$1::uuid AND is_active AND NOT is_banned FOR SHARE',[uuid(id)]))[0];
 if(!row)fail('TON_WALLET_AUTH_INVALID');return row;
}
interface WalletRow extends Record<string,unknown>{id:string;user_id:string;address:string;network:'-3';public_key:string;wallet_version:'v4r2'|'v5r1';code_hash:string;created_at:string;revoked_at:string|null;}
const walletFields='id::text,user_id::text,address,network,public_key,wallet_version,code_hash,created_at::text,revoked_at::text';
function walletView(row:WalletRow):LinkedTonWallet{return {id:row.id,address:row.address,network:row.network,publicKey:row.public_key,walletVersion:row.wallet_version,createdAt:row.created_at};}
export async function issueTonWalletChallenge(db:TonPaymentDatabase,input:TonWalletContext){
 const ctx=context(input),id=randomUUID(),payload='aiag:ton-connect:'+ctx.purpose+':-3:'+randomBytes(32).toString('hex');
 return db.transaction(async tx=>{
  if(ctx.actorUserId)await active(tx,ctx.actorUserId);
  await query(tx,"SELECT pg_advisory_xact_lock(hashtextextended('aiag:wallet:challenge-issue',0))");
  const counters=(await query<{global_n:number;browser_n:number;actor_n:number}>(tx,`SELECT count(*) FILTER(WHERE issued_at>clock_timestamp()-interval '60 seconds')::int AS global_n,
   count(*) FILTER(WHERE browser_hash=$1)::int AS browser_n,count(*) FILTER(WHERE actor_user_id=$2::uuid)::int AS actor_n
   FROM public.user_ton_wallet_challenges WHERE issued_at>clock_timestamp()-interval '5 minutes'`,[ctx.browserHash,ctx.actorUserId]))[0];
  if(!counters||counters.global_n>=200||counters.browser_n>=8||counters.actor_n>=8)fail('TON_WALLET_RATE_LIMIT');
  await query(tx,`DELETE FROM public.user_ton_wallet_challenges WHERE id IN(SELECT id FROM public.user_ton_wallet_challenges WHERE expires_at<clock_timestamp()-interval '24 hours' ORDER BY expires_at LIMIT 100)`);
  const row=(await query<{expires_at:string}>(tx,`WITH moment AS MATERIALIZED(SELECT date_trunc('milliseconds',clock_timestamp()) AS n)
   INSERT INTO public.user_ton_wallet_challenges(id,purpose,actor_user_id,browser_hash,payload_hash,network,domain,issued_at,expires_at)
   SELECT $1::uuid,$2,$3::uuid,$4,$5,'-3',$6,n,n+interval '120 seconds' FROM moment RETURNING expires_at::text`,[id,ctx.purpose,ctx.actorUserId,ctx.browserHash,digest(payload),ctx.domain]))[0];
  if(!row)fail('TON_WALLET_AUTH_UNAVAILABLE');return {challengeId:id,payload,expiresAt:row.expires_at,network:'-3' as const,domain:ctx.domain};
 });
}
interface ChallengeRow extends Record<string,unknown>{id:string;purpose:'link'|'login';actor_user_id:string|null;browser_hash:string;payload_hash:string;network:string;domain:string;issued_ms:string;expires_ms:string;consumed_at:string|null;proof_digest:string|null;wallet_id:string|null;ticket_hash:string|null;ticket_expires_ms:string|null;ticket_used_at:string|null;}
const challengeFields="id::text,purpose,actor_user_id::text,browser_hash,payload_hash,network,domain,floor(extract(epoch FROM issued_at)*1000)::text AS issued_ms,floor(extract(epoch FROM expires_at)*1000)::text AS expires_ms,consumed_at::text,proof_digest,wallet_id::text,ticket_hash,floor(extract(epoch FROM ticket_expires_at)*1000)::text AS ticket_expires_ms,ticket_used_at::text";

export async function completeTonWalletProof(db:TonPaymentDatabase,input:TonWalletContext&{challengeId:string;proof:unknown;consent:boolean}):Promise<{kind:'linked';wallet:LinkedTonWallet}|{kind:'login_ticket';ticket:string;expiresAt:string}>{
 const ctx=context(input),challengeId=uuid(input.challengeId),proof=parseTonWalletProofInput(input.proof);
 if(ctx.purpose==='link'&&input.consent!==true)fail('TON_WALLET_CONSENT_REQUIRED');
 return db.transaction(async tx=>{
  const ch=(await query<ChallengeRow>(tx,'SELECT '+challengeFields+' FROM public.user_ton_wallet_challenges WHERE id=$1::uuid FOR UPDATE',[challengeId]))[0];
  if(!ch||ch.purpose!==ctx.purpose||ch.actor_user_id!==ctx.actorUserId||ch.network!=='-3'||ch.domain!==ctx.domain||!equalHash(ch.browser_hash,ctx.browserHash)||!equalHash(ch.payload_hash,digest(proof.proof.payload)))fail();
  const now=await clock(tx);
  const identity=verifyTonWalletProof(proof,{network:'-3',domain:ch.domain,payload:proof.proof.payload,issuedAtMs:Number(ch.issued_ms),expiresAtMs:Number(ch.expires_ms),nowMs:now});
  await query(tx,"SELECT pg_advisory_xact_lock(hashtextextended('aiag:wallet:address:'||$1,0))",[identity.address]);
  const found=(await query<WalletRow>(tx,'SELECT '+walletFields+" FROM public.user_ton_wallets WHERE network='-3' AND address=$1 AND revoked_at IS NULL FOR UPDATE",[identity.address]))[0];
  const actor=ctx.purpose==='link'?await active(tx,ctx.actorUserId!):found?await active(tx,found.user_id):null;
  if(!actor)fail();
  if(await clock(tx)>=Number(ch.expires_ms))fail('TON_WALLET_CHALLENGE_EXPIRED');
  if(ch.consumed_at){
   if(ctx.purpose!=='link'||!ch.proof_digest||!equalHash(ch.proof_digest,identity.proofDigest)||!found||found.id!==ch.wallet_id||found.user_id!==actor.id)fail('TON_WALLET_CHALLENGE_USED');
   return {kind:'linked',wallet:walletView(found)};
  }
  if(found&&(found.public_key!==identity.publicKey||found.code_hash!==identity.codeHash||found.user_id!==actor.id))fail('TON_WALLET_ALREADY_LINKED');
  let wallet=found;
  if(ctx.purpose==='link'&&!wallet){
   wallet=(await query<WalletRow>(tx,`INSERT INTO public.user_ton_wallets(user_id,network,address,public_key,wallet_version,code_hash)
    VALUES($1::uuid,'-3',$2,$3,$4,$5) RETURNING `+walletFields,[actor.id,identity.address,identity.publicKey,identity.walletVersion,identity.codeHash]))[0];
  }
  if(!wallet)fail();
  const secret=ctx.purpose==='login'?randomBytes(32).toString('hex'):null;
  const updated=(await query<{id:string;ticket_expires_at:string|null}>(tx,`WITH moment AS MATERIALIZED(SELECT date_trunc('milliseconds',clock_timestamp()) AS n)
   UPDATE public.user_ton_wallet_challenges c SET consumed_at=n,proof_digest=$2,wallet_id=$3::uuid,ticket_hash=$4,
    ticket_expires_at=CASE WHEN $4::text IS NULL THEN NULL ELSE n+interval '60 seconds' END FROM moment
   WHERE c.id=$1::uuid AND c.consumed_at IS NULL AND c.expires_at>n RETURNING c.id::text,c.ticket_expires_at::text`,[ch.id,identity.proofDigest,wallet.id,secret?digest(secret):null]))[0];
  if(!updated)fail('TON_WALLET_CHALLENGE_EXPIRED');
  await query(tx,`INSERT INTO public.audit_log(actor_id,actor_type,action,resource_type,resource_id,details)
   VALUES($1::uuid,'user',$2,'ton_wallet',$3,$4::jsonb)`,[actor.id,ctx.purpose==='link'?'wallet.link':'wallet.login.verify',wallet.id,JSON.stringify({challengeId:ch.id,network:'-3'})]);
  if(ctx.purpose==='link')return {kind:'linked',wallet:walletView(wallet)};
  return {kind:'login_ticket',ticket:ch.id+'.'+secret,expiresAt:updated.ticket_expires_at!};
 });
}
export async function consumeTonWalletTicket(db:TonPaymentDatabase,input:{ticket:string;browserHash:string}):Promise<TonWalletLoginUser>{
 hex(input.browserHash);if(typeof input.ticket!=='string'||input.ticket.length!==101)fail();
 const [id,secret]=input.ticket.split('.');uuid(id);hex(secret);
 return db.transaction(async tx=>{
  const ch=(await query<ChallengeRow>(tx,'SELECT '+challengeFields+' FROM public.user_ton_wallet_challenges WHERE id=$1::uuid FOR UPDATE',[id]))[0];
  if(!ch||ch.purpose!=='login'||!ch.consumed_at||!ch.wallet_id||!ch.ticket_hash||ch.ticket_used_at||!equalHash(ch.browser_hash,input.browserHash)||!equalHash(ch.ticket_hash,digest(secret)))fail();
  const wallet=(await query<WalletRow>(tx,'SELECT '+walletFields+' FROM public.user_ton_wallets WHERE id=$1::uuid AND revoked_at IS NULL FOR SHARE',[ch.wallet_id]))[0];if(!wallet)fail();
  const user=await active(tx,wallet.user_id);
  const updated=await query(tx,`UPDATE public.user_ton_wallet_challenges SET ticket_used_at=clock_timestamp()
   WHERE id=$1::uuid AND ticket_used_at IS NULL AND ticket_expires_at>clock_timestamp() RETURNING id`,[id]);
  if(updated.length!==1)fail();
  return {id:user.id,email:user.email,name:user.name,image:user.image,tonWalletId:wallet.id};
 });
}
export async function listTonWallets(db:TonPaymentDatabase,userId:string):Promise<LinkedTonWallet[]>{
 uuid(userId);return db.transaction(async tx=>{await active(tx,userId);return (await query<WalletRow>(tx,'SELECT '+walletFields+' FROM public.user_ton_wallets WHERE user_id=$1::uuid AND revoked_at IS NULL ORDER BY created_at',[userId])).map(walletView);});
}
export async function checkTonWalletSession(db:TonPaymentDatabase,userId:string,walletId:string):Promise<boolean>{
 uuid(userId);uuid(walletId);return db.transaction(async tx=>(await query(tx,`SELECT w.id FROM public.user_ton_wallets w JOIN public.users u ON u.id=w.user_id
  WHERE w.id=$1::uuid AND w.user_id=$2::uuid AND w.revoked_at IS NULL AND u.is_active AND NOT u.is_banned`,[walletId,userId])).length===1);
}
export async function reserveTonWalletPasswordAttempt(db:TonPaymentDatabase,userId:string):Promise<void>{
 uuid(userId);return db.transaction(async tx=>{
  await active(tx,userId);
  const rows=await query(tx,`INSERT INTO public.user_ton_wallet_password_limits(user_id,window_start,attempts) VALUES($1::uuid,clock_timestamp(),1)
   ON CONFLICT(user_id) DO UPDATE SET window_start=CASE WHEN user_ton_wallet_password_limits.window_start<clock_timestamp()-interval '5 minutes' THEN clock_timestamp() ELSE user_ton_wallet_password_limits.window_start END,
    attempts=CASE WHEN user_ton_wallet_password_limits.window_start<clock_timestamp()-interval '5 minutes' THEN 1 ELSE user_ton_wallet_password_limits.attempts+1 END
   WHERE user_ton_wallet_password_limits.window_start<clock_timestamp()-interval '5 minutes' OR user_ton_wallet_password_limits.attempts<8 RETURNING user_id`,[userId]);
  if(rows.length!==1)fail('TON_WALLET_RATE_LIMIT');
 });
}
export async function revokeTonWallet(db:TonPaymentDatabase,input:{actorUserId:string;walletId:string;expectedPasswordHash:string}){
 uuid(input.actorUserId);uuid(input.walletId);if(typeof input.expectedPasswordHash!=='string'||!input.expectedPasswordHash||input.expectedPasswordHash.length>512)fail();
 return db.transaction(async tx=>{
  const row=(await query<WalletRow>(tx,'SELECT '+walletFields+' FROM public.user_ton_wallets WHERE id=$1::uuid AND user_id=$2::uuid',[input.walletId,input.actorUserId]))[0];if(!row)fail();
  await query(tx,"SELECT pg_advisory_xact_lock(hashtextextended('aiag:wallet:address:'||$1,0))",[row.address]);
  const user=await active(tx,input.actorUserId);if(user.password_hash!==input.expectedPasswordHash)fail('TON_WALLET_REAUTH_REQUIRED');
  const changed=await query(tx,'UPDATE public.user_ton_wallets SET revoked_at=clock_timestamp() WHERE id=$1::uuid AND user_id=$2::uuid AND revoked_at IS NULL RETURNING id',[row.id,user.id]);
  if(changed.length)await query(tx,`INSERT INTO public.audit_log(actor_id,actor_type,action,resource_type,resource_id,details) VALUES($1::uuid,'user','wallet.revoke','ton_wallet',$2,'{}'::jsonb)`,[user.id,row.id]);
  return {revoked:true};
 });
}
