import { randomUUID } from 'node:crypto';
import { describe,expect,it,vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { withWalletAuthDb } from '../../../../packages/database/scripts/__tests__/ton-wallet-auth.native.fixture';
import { walletProofFixture } from '../../../../packages/shared/src/__tests__/ton-wallet-proof.fixture';

const identity=vi.hoisted(()=>({id:'' as string|null}));
vi.mock('@/auth',()=>({auth:async()=>identity.id?{user:{id:identity.id}}:null}));

const origin='https://app.example.test';
const policy=()=>JSON.stringify({
 revision:'fixture-v1',recipient:'0:'+'1'.repeat(64),network:'tvm:-3',
 finalityPolicyId:'fixture-finality-v1',verifierVersion:'fixture-verifier-v1',
 quoteLifetimeSeconds:120,maxFxAgeSeconds:600,
 fx:{numerator:'1000',denominator:'1',rounding:'ceil',source:'fixture',observedAtMs:Date.now()-1000,expiresAtMs:Date.now()+300000},
 additionalFeeAtomic:'0',packages:[{id:'test',label:'Fixture',grantMicrocredits:'1000'}],
});
function request(body:unknown,cookie=''){return new Request(origin+'/api/ton',{method:'POST',headers:{origin,'content-type':'application/json',cookie},body:JSON.stringify(body)});}

describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION==='1')('actual Web wallet identity and checkout routes',()=>{
 it('links, logs in once, creates one invoice, claims one send and never credits from wallet ACK',async()=>withWalletAuthDb(async f=>{
  const envNames=['DATABASE_URL','TON_WALLET_ENABLED','TON_WALLET_ORIGIN','TON_WALLET_NETWORK','TON_CHECKOUT_POLICY','AIAG_TEST_DATABASE'];
  const saved=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));let close:(()=>Promise<void>)|undefined;
  try{
   process.env.DATABASE_URL=f.url;process.env.TON_WALLET_ENABLED='1';process.env.TON_WALLET_ORIGIN=origin;process.env.TON_WALLET_NETWORK='-3';process.env.TON_CHECKOUT_POLICY=policy();process.env.AIAG_TEST_DATABASE='1';
   (globalThis as unknown as {db?:unknown}).db=undefined;
   const {db}=await import('../lib/db');close=async()=>{await db.$client.end();(globalThis as unknown as {db?:unknown}).db=undefined;};

   const {POST:challenge}=await import('../app/api/ton/wallet/challenge/route');
   const {POST:proof}=await import('../app/api/ton/wallet/proof/route');
   const {POST:revoke}=await import('../app/api/ton/wallet/revoke/route');
   const {POST:createCheckout}=await import('../app/api/ton/checkout/route');
   const {POST:checkoutAction}=await import('../app/api/ton/checkout/[id]/action/route');
   const {GET:checkoutStatus}=await import('../app/api/ton/checkout/[id]/route');
   const {authorizeWalletTicket,verifyWalletSession}=await import('../lib/ton-wallet/service');

   identity.id=f.user;
   const firstChallenge=await challenge(request({purpose:'link'}));
   expect(firstChallenge.status).toBe(200);
   const cookie=(firstChallenge.headers.get('set-cookie')??'').split(';')[0];
   expect(cookie).toMatch(/^__Host-aiag-ton-browser=[a-f0-9]{64}$/);
   const challengeBody=await firstChallenge.json();

   const linked=await proof(request({purpose:'link',challengeId:challengeBody.challengeId,proof:walletProofFixture(challengeBody.payload),consent:true},cookie));
   expect(linked.status).toBe(200);
   const linkedBody=await linked.json();
   expect(linkedBody.kind).toBe('linked');
   const wallet=linkedBody.wallet;
   expect(await verifyWalletSession(f.user,wallet.id)).toBe(true);

   identity.id=null;
   const loginChallengeResponse=await challenge(request({purpose:'login'},cookie));
   expect(loginChallengeResponse.status).toBe(200);
   const loginChallenge=await loginChallengeResponse.json();
   const ticketResponse=await proof(request({purpose:'login',challengeId:loginChallenge.challengeId,proof:walletProofFixture(loginChallenge.payload),consent:false},cookie));
   expect(ticketResponse.status).toBe(200);
   const ticket=(await ticketResponse.json()).ticket as string;
   const authRequest=new Request(origin+'/api/auth/callback/ton-wallet',{method:'POST',headers:{origin,cookie}});
   expect(await authorizeWalletTicket({ticket},authRequest)).toMatchObject({id:f.user,tonWalletId:wallet.id});
   expect(await authorizeWalletTicket({ticket},authRequest)).toBeNull();

   identity.id=f.user;
   const command={walletId:wallet.id,packageId:'test',idempotencyKey:'checkout-'+randomUUID()};
   const created=await createCheckout(request(command,cookie));
   expect(created.status).toBe(200);
   const checkout=await created.json();
   expect(checkout.invoice.status).toBe('pending');
   expect(checkout.invoice.expectedSender).toBe(wallet.address);

   process.env.TON_CHECKOUT_POLICY='invalid';
   const replay=await createCheckout(request(command,cookie));
   expect(replay.status).toBe(200);
   expect((await replay.json()).checkoutId).toBe(checkout.checkoutId);

   const params={params:Promise.resolve({id:checkout.checkoutId})};
   const claimed=await checkoutAction(request({action:'claim'},cookie),params);
   expect(claimed.status).toBe(200);
   const dispatch=await claimed.json();
   expect(dispatch.didClaim).toBe(true);
   expect(dispatch.transaction).toMatchObject({network:'-3',from:wallet.address});

   const duplicateClaim=await checkoutAction(request({action:'claim'},cookie),params);
   expect((await duplicateClaim.json()).didClaim).toBe(false);

   const advisory=await checkoutAction(request({action:'report',attemptId:dispatch.attemptId,outcome:'client_sent'},cookie),params);
   expect(advisory.status).toBe(200);
   expect(await advisory.json()).toMatchObject({recorded:true,creditGranted:false,outcome:'client_sent',attemptId:dispatch.attemptId});

   const status=await checkoutStatus(new Request(origin+'/api/ton/checkout/'+checkout.checkoutId),params);
   expect(status.status).toBe(200);
   expect((await status.json()).invoice.status).toBe('pending');
   expect((await f.query("SELECT count(*)::int AS n FROM gateway_transactions WHERE source='ton'"))[0].n).toBe(0);

   identity.id=f.other;
   expect((await checkoutStatus(new Request(origin+'/api/ton/checkout/'+checkout.checkoutId),params)).status).not.toBe(200);

   identity.id=f.user;
   const password='CurrentProof1';
   await f.query('UPDATE users SET password_hash=$1 WHERE id=$2',[await bcrypt.hash(password,4),f.user]);
   expect((await revoke(request({walletId:wallet.id,password:'Wrong'},cookie))).status).toBe(403);
   expect((await revoke(request({walletId:wallet.id,password},cookie))).status).toBe(200);
   expect(await verifyWalletSession(f.user,wallet.id)).toBe(false);
  }finally{
   await close?.();
   for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
 }),120000);
});
