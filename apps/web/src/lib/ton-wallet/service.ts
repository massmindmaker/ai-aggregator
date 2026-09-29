import { db } from '@/lib/db';
import bcrypt from 'bcryptjs';
import { issueTonWalletChallenge,completeTonWalletProof,consumeTonWalletTicket,listTonWallets,checkTonWalletSession,reserveTonWalletPasswordAttempt,revokeTonWallet,type TonPaymentDatabase,type TonWalletContext } from '@aiag/database';
import { checkTonOrigin,tonBrowser,tonConfig,TonWebError } from './http';
/** Owns one real pg transaction; only the already configured Web pool, never a worker credential. */
export const walletDatabase:TonPaymentDatabase={async transaction(run){
 const client=await db.$client.connect();let began=false,released=false;
 try{await client.query('BEGIN');began=true;await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL idle_in_transaction_session_timeout='8s'");
  const result=await run({query:async config=>{const r=await client.query(config.text,[...config.values]);return {rows:r.rows,rowCount:r.rowCount};}});await client.query('COMMIT');began=false;return result;
 }catch(error){if(began)try{await client.query('ROLLBACK');}catch{client.release(true);released=true;began=false;throw error;}throw error;}
 finally{if(!released)client.release();}
}};
export const issueWallet=(context:TonWalletContext)=>issueTonWalletChallenge(walletDatabase,context);
export const completeWallet=(context:Parameters<typeof completeTonWalletProof>[1])=>completeTonWalletProof(walletDatabase,context);
export const listWallets=(userId:string)=>listTonWallets(walletDatabase,userId);
export async function revokeWallet(userId:string,input:{walletId:string;password:string}){
 await reserveTonWalletPasswordAttempt(walletDatabase,userId);
 const user=await db.query.users.findFirst({where:(u,{eq})=>eq(u.id,userId),columns:{passwordHash:true,isActive:true,isBanned:true}});
 if(!user?.passwordHash||!user.isActive||user.isBanned||!await bcrypt.compare(input.password,user.passwordHash))throw new TonWebError('TON_WALLET_REAUTH_REQUIRED',403);
 return revokeTonWallet(walletDatabase,{actorUserId:userId,walletId:input.walletId,expectedPasswordHash:user.passwordHash});
}
export async function authorizeWalletTicket(credentials:Partial<Record<string,unknown>>,request:Request){
 try{if(!request)return null;const config=checkTonOrigin(request,tonConfig()),browser=tonBrowser(request,config);if(typeof credentials.ticket!=='string')return null;
  return await consumeTonWalletTicket(walletDatabase,{ticket:credentials.ticket,browserHash:browser.hash});
 }catch{return null;}
}
export async function verifyWalletSession(userId:string,walletId:string){try{tonConfig();return await checkTonWalletSession(walletDatabase,userId,walletId);}catch{return false;}}
