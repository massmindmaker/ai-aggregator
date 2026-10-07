import { createTonCheckout,readTonCheckout,claimTonCheckoutSend,recordTonCheckoutClientReport,type TonCheckoutInput } from '@aiag/database';
import { db,sql } from '@/lib/db';
import { getOrCreateDefaultOrg } from '@/lib/dashboard/org';
import { walletDatabase,listWallets } from './service';
import { activeCheckoutPolicy } from './checkout-policy-source';
import { TonWebError } from './http';
async function context(actorUserId:string){const orgId=await getOrCreateDefaultOrg(actorUserId);return {actorUserId,orgId};}
export async function checkoutOptions(actorUserId:string){const wallets=await listWallets(actorUserId),ctx=await context(actorUserId);
 const result=await db.execute(sql`SELECT id FROM organizations WHERE id=${ctx.orgId}::uuid AND owner_id=${actorUserId}::uuid`);
 if(!(result as {rows:unknown[]}).rows?.length)throw new TonWebError('TON_CHECKOUT_NOT_AUTHORIZED',403);
 const p=await activeCheckoutPolicy();return {orgId:ctx.orgId,wallets,packages:p.packages,revision:p.revision,network:'-3',testnet:true};
}
export async function createCheckout(actor:string,input:TonCheckoutInput){const p=await activeCheckoutPolicy();return createTonCheckout(walletDatabase,await context(actor),input,()=>p);}
export async function readCheckout(actor:string,id:string){return readTonCheckout(walletDatabase,await context(actor),id);}
export async function claimCheckout(actor:string,id:string){return claimTonCheckoutSend(walletDatabase,await context(actor),id);}
export async function recordCheckoutClientReport(actor:string,input:Parameters<typeof recordTonCheckoutClientReport>[2]){return recordTonCheckoutClientReport(walletDatabase,await context(actor),input);}
