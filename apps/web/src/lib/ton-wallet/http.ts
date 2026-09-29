import { createHash,randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
export class TonWebError extends Error{constructor(readonly code:string,readonly status=400){super(code);}}
export interface TonWebConfig{origin:string;domain:string;network:'-3';secure:boolean;cookieName:string;}
export function tonConfig():TonWebConfig{
 if(process.env.TON_WALLET_ENABLED!=='1')throw new TonWebError('TON_WALLET_DISABLED',503);
 try{const raw=process.env.TON_WALLET_ORIGIN??'',u=new URL(raw);
  const local=u.protocol==='http:'&&u.hostname==='127.0.0.1'&&process.env.AIAG_TEST_DATABASE==='1'&&new URL(process.env.DATABASE_URL??'').hostname==='127.0.0.1';
  if(raw!==u.origin||u.username||u.password||u.search||u.hash||!u.hostname.includes('.')||(!local&&u.protocol!=='https:')||process.env.TON_WALLET_NETWORK!=='-3')throw Error();
  return {origin:u.origin,domain:u.host,network:'-3',secure:!local,cookieName:local?'aiag-ton-browser-test':'__Host-aiag-ton-browser'};
 }catch{throw new TonWebError('TON_WALLET_CONFIGURATION_UNAVAILABLE',503);}
}
export function checkTonOrigin(request:Request,config=tonConfig()){
 if(request.headers.get('origin')!==config.origin)throw new TonWebError('TON_WALLET_ORIGIN_REJECTED',403);
 const site=request.headers.get('sec-fetch-site');if(site&&site!=='same-origin'&&site!=='none')throw new TonWebError('TON_WALLET_ORIGIN_REJECTED',403);
 return config;
}
export function tonBrowser(request:Request,config:TonWebConfig,create=false){
 const raw=request.headers.get('cookie')??'';if(raw.length>8192)throw new TonWebError('TON_WALLET_BROWSER_REQUIRED',403);
 const values=raw.split(';').map(part=>part.trim()).filter(part=>part.startsWith(config.cookieName+'='));
 const existing=values.length===1?values[0].slice(config.cookieName.length+1):'';
 if(existing.length===64&&/^[a-f0-9]{64}$/.test(existing))return {hash:createHash('sha256').update(existing).digest('hex'),cookie:null as string|null};
 if(!create)throw new TonWebError('TON_WALLET_BROWSER_REQUIRED',403);
 const secret=randomBytes(32).toString('hex');return {hash:createHash('sha256').update(secret).digest('hex'),cookie:config.cookieName+'='+secret+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=600'+(config.secure?'; Secure':'')};
}
export async function readTonBody<T>(req:Request,schema:z.ZodType<T>):Promise<T>{
 if(req.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase()!=='application/json'||!req.body)throw new TonWebError('TON_WALLET_INPUT_INVALID');
 const declared=req.headers.get('content-length');if(declared&&(!/^[0-9]{1,8}$/.test(declared)||Number(declared)>24576))throw new TonWebError('TON_WALLET_INPUT_INVALID');
 const reader=req.body.getReader(),parts:Uint8Array[]=[];let length=0;let timer:ReturnType<typeof setTimeout>|undefined;
 const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new TonWebError('TON_WALLET_INPUT_INVALID')),5000);});
 try{for(;;){const part=await Promise.race([reader.read(),expired]);if(req.signal.aborted)throw Error();if(part.done)break;length+=part.value.byteLength;if(length>24576)throw Error();parts.push(part.value);}
  const bytes=new Uint8Array(length);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
  const result=schema.safeParse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)));if(!result.success)throw Error();return result.data;
 }catch{throw new TonWebError('TON_WALLET_INPUT_INVALID');}
 finally{if(timer)clearTimeout(timer);void reader.cancel().catch(()=>undefined);try{reader.releaseLock();}catch{}}
}
export const challengeSchema=z.object({purpose:z.enum(['link','login'])}).strict();
export const proofSchema=z.object({
 purpose:z.enum(['link','login']),challengeId:z.string().uuid(),
 proof:z.object({
  address:z.string(),network:z.literal('-3'),publicKey:z.string(),walletStateInit:z.string(),
  proof:z.object({
   timestamp:z.union([z.string(),z.number()]),
   domain:z.object({lengthBytes:z.number(),value:z.string()}).strict(),
   payload:z.string(),signature:z.string(),
  }).strict(),
 }).strict(),
 consent:z.boolean(),
}).strict();
export const revokeSchema=z.object({walletId:z.string().uuid(),password:z.string().min(1).max(128)}).strict();
export function tonJson(value:unknown,status=200,headers:Record<string,string>={}){return NextResponse.json(value,{status,headers:{'Cache-Control':'private, no-store',...headers}});}
export function tonError(error:unknown){
 if(error instanceof TonWebError)return tonJson({error:error.code},error.status);
 const code=error instanceof Error?error.message:'';
 if(code==='TON_CHECKOUT_NOT_AUTHORIZED')return tonJson({error:code},403);
 if(code==='TON_CHECKOUT_NOT_FOUND')return tonJson({error:code},404);
 if(['TON_CHECKOUT_CONFLICT','TON_CHECKOUT_NOT_SENDABLE','TON_CHECKOUT_EXPIRED','TON_CHECKOUT_WALLET_UNAVAILABLE'].includes(code))return tonJson({error:code},409);
 if(code==='TON_CHECKOUT_RATE_LIMIT')return tonJson({error:code},429);
 if(code==='TON_WALLET_RATE_LIMIT')return tonJson({error:code},429);
 if(code==='TON_WALLET_REAUTH_REQUIRED')return tonJson({error:code},403);
 if(['TON_WALLET_PROOF_INVALID','TON_WALLET_AUTH_INVALID','TON_WALLET_CONSENT_REQUIRED','TON_WALLET_ALREADY_LINKED','TON_WALLET_CHALLENGE_USED','TON_WALLET_CHALLENGE_EXPIRED'].includes(code))return tonJson({error:'TON_WALLET_PROOF_NOT_ACCEPTED'},400);
 return tonJson({error:'TON_WALLET_UNAVAILABLE'},503);
}
