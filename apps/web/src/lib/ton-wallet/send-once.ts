import { beginCell } from '@ton/core';
/** Client coordinator: only an acknowledged owned claim allows a single SDK send. Never grants credit. */
export interface TonPreparedTransaction{network:'-3';from:string;validUntil:number;messages:[{address:string;amount:string;payload:string}];}
interface DisplayedInvoice{reference:string;expectedSender:string|null;recipient:string;amountAtomic:string;expiresAt:string;}
interface Dependencies{claim:()=>Promise<unknown>;send:(transaction:TonPreparedTransaction)=>Promise<unknown>;report:(value:{attemptId:string;outcome:'client_sent'|'client_unknown'})=>Promise<unknown>;}
export async function sendOwnedTonCheckout(invoice:DisplayedInvoice,connectedAddress:string|null,deps:Dependencies):Promise<{state:'wallet_changed'|'unknown'|'wallet_ack'}>{
 if(!connectedAddress||connectedAddress!==invoice.expectedSender)return {state:'wallet_changed'};
 let attemptId:string|undefined;
 try{const result=await deps.claim() as {didClaim?:unknown;attemptId?:unknown;transaction?:TonPreparedTransaction};
  if(result?.didClaim!==true||typeof result.attemptId!=='string'||!/^[a-f0-9-]{36}$/.test(result.attemptId))return {state:'unknown'};
  attemptId=result.attemptId;const tx=result.transaction;
  if(!tx||tx.network!=='-3'||tx.from!==connectedAddress||!Number.isSafeInteger(tx.validUntil)||tx.validUntil<=Math.floor(Date.now()/1000)||tx.validUntil!==Math.floor(Date.parse(invoice.expiresAt)/1000)||!Array.isArray(tx.messages)||tx.messages.length!==1||tx.messages[0].address!==invoice.recipient||tx.messages[0].amount!==invoice.amountAtomic||typeof tx.messages[0].payload!=='string'||tx.messages[0].payload.length>4096)return {state:'unknown'};
  if(typeof invoice.reference!=='string'||invoice.reference.length>256||tx.messages[0].payload!==beginCell().storeUint(0,32).storeStringTail(invoice.reference).endCell().toBoc().toString('base64'))return {state:'unknown'};
  // Do not forward unknown extra transaction fields supplied by any upstream response.
  const transaction:TonPreparedTransaction={network:'-3',from:connectedAddress,validUntil:tx.validUntil,messages:[{address:invoice.recipient,amount:invoice.amountAtomic,payload:tx.messages[0].payload}]};
  await deps.send(transaction);try{await deps.report({attemptId,outcome:'client_sent'});}catch{return {state:'unknown'};}
  return {state:'wallet_ack'};
 }catch{if(attemptId)try{await deps.report({attemptId,outcome:'client_unknown'});}catch{}return {state:'unknown'};}
}
