import { createHash,randomUUID } from 'node:crypto';
import { createQuote,type RationalFx } from '@aiag/shared/ton-payment-contract';
import { beginCell } from '@ton/core';
import { createTonInvoice,getTonInvoice } from './ton-payments';
import type { TonPaymentDatabase,TonSqlClient,TonInvoice,TonInvoiceContext } from './ton-payment-types';
export interface TonCheckoutPolicy{revision:string;recipient:string;network:'tvm:-3';finalityPolicyId:string;verifierVersion:string;quoteLifetimeSeconds:number;maxFxAgeSeconds:number;fx:RationalFx&{source:string;observedAtMs:number;expiresAtMs:number};additionalFeeAtomic:string;packages:readonly {id:string;label:string;grantMicrocredits:string}[];}
export interface TonCheckoutInput{walletId:string;packageId:string;idempotencyKey:string;}
export interface TonCheckout{checkoutId:string;invoice:TonInvoice;walletId:string;packageId:string;sendState:'not_sent'|'unknown'|'client_sent'|'client_rejected'|'client_unknown';attemptId:string|null;}
interface Row extends Record<string,unknown>{id:string;owner_user_id:string;org_id:string;wallet_id:string;package_id:string;invoice_id:string;send_attempt_id:string|null;client_report:'client_sent'|'client_rejected'|'client_unknown'|null;client_reported_at:string|null;}
const asset={network:'tvm:-3',kind:'native',decimals:9} as const;
const fields='id::text,owner_user_id::text,org_id::text,wallet_id::text,package_id,invoice_id::text,send_attempt_id::text,client_report,client_reported_at::text';
function fail(message='TON_CHECKOUT_INVALID'):never{throw Error(message);}
function uuid(v:string){if(typeof v!=='string'||v.length!==36||!/^[a-f0-9-]{36}$/.test(v))fail();return v;}
async function q<R extends Record<string,unknown>>(tx:TonSqlClient,text:string,values:readonly unknown[]=[]):Promise<R[]>{return (await tx.query<R>({text,values})).rows;}
const nested=(tx:TonSqlClient):TonPaymentDatabase=>({transaction:fn=>fn(tx)});
async function own(tx:TonSqlClient,ctx:TonInvoiceContext){
 uuid(ctx.actorUserId);uuid(ctx.orgId);
 if((await q(tx,'SELECT id FROM public.users WHERE id=$1::uuid AND is_active AND NOT is_banned FOR SHARE',[ctx.actorUserId])).length!==1)fail('TON_CHECKOUT_NOT_AUTHORIZED');
 if((await q(tx,'SELECT id FROM public.organizations WHERE id=$1::uuid AND owner_id=$2::uuid FOR UPDATE',[ctx.orgId,ctx.actorUserId])).length!==1)fail('TON_CHECKOUT_NOT_AUTHORIZED');
}
async function view(tx:TonSqlClient,ctx:TonInvoiceContext,row:Row):Promise<TonCheckout>{
 const invoice=await getTonInvoice(nested(tx),ctx,row.invoice_id);if(!invoice)fail('TON_CHECKOUT_NOT_FOUND');
 return {checkoutId:row.id,invoice,walletId:row.wallet_id,packageId:row.package_id,attemptId:row.send_attempt_id,sendState:row.client_report??(row.send_attempt_id?'unknown':'not_sent')};
}
async function wallet(tx:TonSqlClient,ctx:TonInvoiceContext,id:string){
 const w=(await q<{address:string}>(tx,"SELECT address FROM public.user_ton_wallets WHERE id=$1::uuid AND user_id=$2::uuid AND network='-3' AND revoked_at IS NULL FOR SHARE",[uuid(id),ctx.actorUserId]))[0];if(!w)fail('TON_CHECKOUT_WALLET_UNAVAILABLE');return w;
}
export async function createTonCheckout(db:TonPaymentDatabase,ctx:TonInvoiceContext,input:TonCheckoutInput,policy:()=>TonCheckoutPolicy):Promise<TonCheckout>{
 uuid(input.walletId);if(!/^[a-zA-Z0-9_-]{1,64}$/.test(input.packageId)||!/^[a-zA-Z0-9_-]{1,96}$/.test(input.idempotencyKey))fail();
 const hash=createHash('sha256').update(input.idempotencyKey).digest('hex');
 return db.transaction(async tx=>{
  await own(tx,ctx);const prior=(await q<Row>(tx,'SELECT '+fields+' FROM public.user_ton_checkouts WHERE owner_user_id=$1::uuid AND org_id=$2::uuid AND key_hash=$3',[ctx.actorUserId,ctx.orgId,hash]))[0];
  if(prior){if(prior.wallet_id!==input.walletId||prior.package_id!==input.packageId)fail('TON_CHECKOUT_CONFLICT');return view(tx,ctx,prior);}
  const w=await wallet(tx,ctx,input.walletId),p=policy();if(p.network!=='tvm:-3'||!Number.isInteger(p.quoteLifetimeSeconds)||p.quoteLifetimeSeconds<30||p.quoteLifetimeSeconds>600||p.packages.length>20)fail();
  const item=p.packages.filter(x=>x.id===input.packageId);if(item.length!==1)fail('TON_CHECKOUT_PACKAGE_UNAVAILABLE');
  const counts=(await q<{n:number}>(tx,"SELECT count(*)::int AS n FROM public.user_ton_checkouts WHERE owner_user_id=$1::uuid AND created_at>clock_timestamp()-interval '5 minutes'",[ctx.actorUserId]))[0];if(counts.n>=12)fail('TON_CHECKOUT_RATE_LIMIT');
  const now=Number((await q<{now:string}>(tx,'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'))[0].now);
  if(!Number.isSafeInteger(p.maxFxAgeSeconds)||p.maxFxAgeSeconds<1||p.maxFxAgeSeconds>86400||!Number.isSafeInteger(p.fx.observedAtMs)||p.fx.observedAtMs>now||now-p.fx.observedAtMs>p.maxFxAgeSeconds*1000||p.fx.expiresAtMs<=now)fail('TON_CHECKOUT_FX_STALE');
  const quote=createQuote({quoteId:'checkout-'+randomUUID(),sourcePrice:{unit:'gateway_microcredits',amountAtomic:item[0].grantMicrocredits},asset,fx:{...p.fx,sourceUnit:'gateway_microcredits',targetAsset:asset},additionalFeeAtomic:p.additionalFeeAtomic,expiresAtMs:Math.min(now+p.quoteLifetimeSeconds*1000,p.fx.expiresAtMs)},[asset],now);
  const invoice=await createTonInvoice(nested(tx),ctx,{idempotencyKey:'wallet-'+hash,grantMicrocredits:item[0].grantMicrocredits,priceRevision:p.revision,quote,recipient:p.recipient,expectedSender:w.address,finalityPolicyId:p.finalityPolicyId,verifierVersion:p.verifierVersion},{allowlist:[asset]});
  const row=(await q<Row>(tx,`INSERT INTO public.user_ton_checkouts(owner_user_id,org_id,wallet_id,package_id,key_hash,invoice_id,policy_snapshot)
   VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::jsonb) RETURNING `+fields,[ctx.actorUserId,ctx.orgId,input.walletId,input.packageId,hash,invoice.invoiceId,JSON.stringify({revision:p.revision,package:item[0],quote,recipient:p.recipient})]))[0];
  if(!row)fail();return view(tx,ctx,row);
 });
}
export async function readTonCheckout(db:TonPaymentDatabase,ctx:TonInvoiceContext,id:string){uuid(id);return db.transaction(async tx=>{await own(tx,ctx);const row=(await q<Row>(tx,'SELECT '+fields+' FROM public.user_ton_checkouts WHERE id=$1::uuid AND owner_user_id=$2::uuid AND org_id=$3::uuid',[id,ctx.actorUserId,ctx.orgId]))[0];if(!row)fail('TON_CHECKOUT_NOT_FOUND');return view(tx,ctx,row);});}
export async function claimTonCheckoutSend(db:TonPaymentDatabase,ctx:TonInvoiceContext,id:string){
 uuid(id);return db.transaction(async tx=>{
  await own(tx,ctx);const row=(await q<Row>(tx,'SELECT '+fields+' FROM public.user_ton_checkouts WHERE id=$1::uuid AND owner_user_id=$2::uuid AND org_id=$3::uuid FOR UPDATE',[id,ctx.actorUserId,ctx.orgId]))[0];if(!row)fail('TON_CHECKOUT_NOT_FOUND');
  if(row.send_attempt_id)return {didClaim:false,attemptId:row.send_attempt_id,transaction:null};
  const w=await wallet(tx,ctx,row.wallet_id),v=await view(tx,ctx,row);const validUntil=Math.floor(Date.parse(v.invoice.expiresAt)/1000);
  const payload=beginCell().storeUint(0,32).storeStringTail(v.invoice.reference).endCell().toBoc().toString('base64');
  if(v.invoice.expectedSender!==w.address||!['pending','observed'].includes(v.invoice.status))fail('TON_CHECKOUT_NOT_SENDABLE');
  const attempt=randomUUID();const updated=await q(tx,`UPDATE public.user_ton_checkouts SET send_attempt_id=$2::uuid
   WHERE id=$1::uuid AND send_attempt_id IS NULL AND $3::bigint>extract(epoch FROM clock_timestamp()) RETURNING id`,[id,attempt,validUntil]);if(updated.length!==1)fail('TON_CHECKOUT_EXPIRED');
  return {didClaim:true,attemptId:attempt,transaction:{network:'-3' as const,from:w.address,validUntil,messages:[{address:v.invoice.recipient,amount:v.invoice.amountAtomic,payload}]}};
 });
}
export async function recordTonCheckoutClientReport(db:TonPaymentDatabase,ctx:TonInvoiceContext,input:{checkoutId:string;attemptId:string;outcome:'client_sent'|'client_rejected'|'client_unknown'}){
 uuid(input.checkoutId);uuid(input.attemptId);if(!['client_sent','client_rejected','client_unknown'].includes(input.outcome))fail();
 return db.transaction(async tx=>{
  await own(tx,ctx);
  let row=(await q<Row>(tx,'SELECT '+fields+' FROM public.user_ton_checkouts WHERE id=$1::uuid AND owner_user_id=$2::uuid AND org_id=$3::uuid FOR UPDATE',[input.checkoutId,ctx.actorUserId,ctx.orgId]))[0];
  if(!row||row.send_attempt_id!==input.attemptId)fail('TON_CHECKOUT_CONFLICT');
  if(row.client_report&&row.client_report!==input.outcome)fail('TON_CHECKOUT_CONFLICT');
  if(!row.client_report){
   row=(await q<Row>(tx,'UPDATE public.user_ton_checkouts SET client_report=$2 WHERE id=$1::uuid AND client_report IS NULL RETURNING '+fields,[input.checkoutId,input.outcome]))[0];
   if(!row)fail('TON_CHECKOUT_CONFLICT');
  }
  return {recorded:true,creditGranted:false,attemptId:row.send_attempt_id!,outcome:row.client_report!,reportedAt:row.client_reported_at!};
 });
}
