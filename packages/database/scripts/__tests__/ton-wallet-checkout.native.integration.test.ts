import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe,expect,it } from 'vitest';
import { withWalletAuthDb } from './ton-wallet-auth.native.fixture';
import { walletProofFixture } from '../../../shared/src/__tests__/ton-wallet-proof.fixture';
import { issueTonWalletChallenge,completeTonWalletProof } from '../../src/ton-wallet-auth';
import { createTonCheckout,readTonCheckout,claimTonCheckoutSend,recordTonCheckoutClientReport,type TonCheckoutPolicy } from '../../src/ton-wallet-checkout';
const policy=():TonCheckoutPolicy=>({revision:'fixture-only-v1',recipient:'0:'+'1'.repeat(64),network:'tvm:-3',finalityPolicyId:'fixture-finality-v1',verifierVersion:'fixture-verifier-v1',quoteLifetimeSeconds:120,maxFxAgeSeconds:600,fx:{numerator:'1000',denominator:'1',rounding:'ceil',source:'fixture-rate-v1',observedAtMs:Date.now()-1000,expiresAtMs:Date.now()+300000},additionalFeeAtomic:'2',packages:[{id:'tiny',label:'Synthetic package',grantMicrocredits:'1001'}]});
async function ready(f:Parameters<Parameters<typeof withWalletAuthDb>[0]>[0]){const ctx={actorUserId:f.user,purpose:'link' as const,browserHash:'a'.repeat(64),domain:'app.example.test'},ch=await issueTonWalletChallenge(f.db,ctx),proof=walletProofFixture(ch.payload);const r=await completeTonWalletProof(f.db,{...ctx,challengeId:ch.challengeId,proof,consent:true});if(r.kind!=='linked')throw Error();const org=randomUUID();await f.query("INSERT INTO organizations(id,name,slug,owner_id,payg_credits) VALUES($1::uuid,'fixture',$1::text,$2::uuid,0)",[org,f.user]);return {ctx:{actorUserId:f.user,orgId:org},input:{packageId:'tiny',walletId:r.wallet.id,idempotencyKey:'test-'+randomUUID()},wallet:r.wallet};}
describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION==='1')('wallet checkout one invoice and one advisory send',()=>{
 it('captures exact policy and replays saved invoice before changed prices',async()=>withWalletAuthDb(async f=>{const x=await ready(f);const a=await createTonCheckout(f.db,x.ctx,x.input,()=>policy());expect(a.invoice.amountAtomic).toBe('1001002');expect(a.invoice.expectedSender).toBe(x.wallet.address);const b=await createTonCheckout(f.db,x.ctx,x.input,()=>{throw Error('pricing offline');});expect(b).toEqual(a);expect((await f.query('SELECT count(*)::int AS n FROM ton_invoices'))[0].n).toBe(1);expect((await f.query("SELECT payg_credits::text AS n FROM organizations WHERE id=$1",[x.ctx.orgId]))[0].n).toBe('0');}),120000);
 it('rejects client command drift and foreign owners, never minting invoice twice',async()=>withWalletAuthDb(async f=>{const x=await ready(f);await createTonCheckout(f.db,x.ctx,x.input,()=>policy());await expect(createTonCheckout(f.db,x.ctx,{...x.input,packageId:'other'},()=>policy())).rejects.toThrow('TON_CHECKOUT_CONFLICT');await expect(createTonCheckout(f.db,{...x.ctx,actorUserId:f.other},x.input,()=>policy())).rejects.toBeDefined();expect((await f.query('SELECT count(*)::int AS n FROM ton_invoices'))[0].n).toBe(1);}),120000);
 it('serializes concurrent creation and commits intent and invoice together',async()=>withWalletAuthDb(async f=>{const x=await ready(f);const [a,b]=await Promise.all([createTonCheckout(f.db,x.ctx,x.input,()=>policy()),createTonCheckout(f.db,x.ctx,x.input,()=>policy())]);expect(a.checkoutId).toBe(b.checkoutId);expect(a.invoice.invoiceId).toBe(b.invoice.invoiceId);await f.query(`CREATE FUNCTION pg_temp.reject_checkout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`);await f.query('CREATE TRIGGER reject_checkout BEFORE INSERT ON user_ton_checkouts FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_checkout()');await expect(createTonCheckout(f.db,x.ctx,{...x.input,idempotencyKey:'rollback'},()=>policy())).rejects.toBeDefined();expect((await f.query('SELECT count(*)::int AS n FROM ton_invoices'))[0].n).toBe(1);}),120000);
 it('grants exactly one send claim and wallet acknowledgement never grants credits',async()=>withWalletAuthDb(async f=>{const x=await ready(f),a=await createTonCheckout(f.db,x.ctx,x.input,()=>policy());const claims=await Promise.all([claimTonCheckoutSend(f.db,x.ctx,a.checkoutId),claimTonCheckoutSend(f.db,x.ctx,a.checkoutId)]);expect(claims.filter(c=>c.didClaim)).toHaveLength(1);const accepted=claims.find(c=>c.didClaim)!;expect(accepted.transaction).toMatchObject({network:'-3',from:x.wallet.address,messages:[{address:policy().recipient,amount:'1001002'}]});await recordTonCheckoutClientReport(f.db,x.ctx,{checkoutId:a.checkoutId,attemptId:accepted.attemptId!,outcome:'client_sent'});expect((await readTonCheckout(f.db,x.ctx,a.checkoutId)).invoice.status).toBe('pending');expect((await f.query('SELECT count(*)::int AS n FROM gateway_transactions'))[0].n).toBe(0);expect((await claimTonCheckoutSend(f.db,x.ctx,a.checkoutId)).didClaim).toBe(false);}),120000);
 it('retains unknown dispatch after ACK loss and never reissues a second transaction',async()=>withWalletAuthDb(async f=>{const x=await ready(f),a=await createTonCheckout(f.db,x.ctx,x.input,()=>policy());const claimed=await claimTonCheckoutSend(f.db,x.ctx,a.checkoutId);expect(claimed.didClaim).toBe(true);const retry=await claimTonCheckoutSend(f.db,x.ctx,a.checkoutId);expect(retry.didClaim).toBe(false);expect(retry.transaction).toBeNull();await expect(recordTonCheckoutClientReport(f.db,x.ctx,{checkoutId:a.checkoutId,attemptId:randomUUID(),outcome:'client_sent'})).rejects.toBeDefined();}),120000);
 it('rejects revoked wallets and stale server FX for new invoices',async()=>withWalletAuthDb(async f=>{const x=await ready(f);await expect(createTonCheckout(f.db,x.ctx,x.input,()=>({...policy(),fx:{...policy().fx,expiresAtMs:1}}))).rejects.toBeDefined();await f.query('UPDATE user_ton_wallets SET revoked_at=clock_timestamp() WHERE id=$1',[x.wallet.id]);await expect(createTonCheckout(f.db,x.ctx,x.input,()=>policy())).rejects.toBeDefined();expect((await f.query('SELECT count(*)::int AS n FROM ton_invoices'))[0].n).toBe(0);}),120000);
 it('rejects server FX older than its explicit policy age and revoked credentials at send time',async()=>withWalletAuthDb(async f=>{const x=await ready(f);await expect(createTonCheckout(f.db,x.ctx,x.input,()=>({...policy(),maxFxAgeSeconds:30,fx:{...policy().fx,observedAtMs:Date.now()-31000}}))).rejects.toBeDefined();const a=await createTonCheckout(f.db,x.ctx,x.input,()=>policy());await f.query('UPDATE user_ton_wallets SET revoked_at=clock_timestamp() WHERE id=$1',[x.wallet.id]);await expect(claimTonCheckoutSend(f.db,x.ctx,a.checkoutId)).rejects.toBeDefined();expect((await readTonCheckout(f.db,x.ctx,a.checkoutId)).attemptId).toBeNull();}),120000);

 it('preserves idempotency history against deletion and exposes owner/context foreign keys',async()=>withWalletAuthDb(async f=>{
  const x=await ready(f),a=await createTonCheckout(f.db,x.ctx,x.input,()=>policy());
  await expect(f.query('DELETE FROM user_ton_checkouts WHERE id=$1',[a.checkoutId])).rejects.toThrow('TON_CHECKOUT_IMMUTABLE');
  expect((await f.query('SELECT count(*)::int AS n FROM user_ton_checkouts WHERE id=$1',[a.checkoutId]))[0].n).toBe(1);
  const constraints=(await f.query("SELECT conname FROM pg_constraint WHERE conrelid='user_ton_checkouts'::regclass ORDER BY conname")).map((r:any)=>r.conname);
  expect(constraints).toEqual(expect.arrayContaining(['user_ton_checkouts_wallet_owner_fk','user_ton_checkouts_org_owner_fk','user_ton_checkouts_invoice_context_fk']));
 }),120000);
 it('returns the immutable client report on identical replay and conflicts on a changed report',async()=>withWalletAuthDb(async f=>{
  const x=await ready(f),a=await createTonCheckout(f.db,x.ctx,x.input,()=>policy()),claimed=await claimTonCheckoutSend(f.db,x.ctx,a.checkoutId);
  const input={checkoutId:a.checkoutId,attemptId:claimed.attemptId!,outcome:'client_sent' as const};
  const first=await recordTonCheckoutClientReport(f.db,x.ctx,input),second=await recordTonCheckoutClientReport(f.db,x.ctx,input);
  expect(second).toEqual(first);expect(first).toMatchObject({recorded:true,creditGranted:false,outcome:'client_sent',attemptId:claimed.attemptId});
  await expect(recordTonCheckoutClientReport(f.db,x.ctx,{...input,outcome:'client_unknown'})).rejects.toThrow('TON_CHECKOUT_CONFLICT');
 }),120000);

 it('rejects direct SQL state jumps that bypass the one-claim then one-report sequence',async()=>withWalletAuthDb(async f=>{
  const x=await ready(f),a=await createTonCheckout(f.db,x.ctx,x.input,()=>policy()),attempt=randomUUID();
  await expect(f.query("UPDATE user_ton_checkouts SET client_report='client_sent',client_reported_at=clock_timestamp() WHERE id=$1",[a.checkoutId])).rejects.toBeDefined();
  await expect(f.query("UPDATE user_ton_checkouts SET send_attempt_id=$2,send_claimed_at=clock_timestamp(),client_report='client_sent',client_reported_at=clock_timestamp() WHERE id=$1",[a.checkoutId,attempt])).rejects.toThrow('TON_CHECKOUT_INVALID_TRANSITION');
  expect((await f.query('SELECT send_attempt_id,client_report FROM user_ton_checkouts WHERE id=$1',[a.checkoutId]))[0]).toEqual({send_attempt_id:null,client_report:null});
 }),120000);

 it('database owns claim/report timestamps and keeps them immutable',async()=>withWalletAuthDb(async f=>{
  const x=await ready(f),a=await createTonCheckout(f.db,x.ctx,x.input,()=>policy()),attempt=randomUUID();
  await f.query("UPDATE user_ton_checkouts SET send_attempt_id=$2,send_claimed_at='2000-01-01T00:00:00Z' WHERE id=$1",[a.checkoutId,attempt]);
  let row=(await f.query('SELECT send_claimed_at::text,client_reported_at::text FROM user_ton_checkouts WHERE id=$1',[a.checkoutId]))[0];
  expect(Date.parse(row.send_claimed_at)).toBeGreaterThan(Date.now()-60000);
  await f.query("UPDATE user_ton_checkouts SET client_report='client_sent',client_reported_at='2000-01-01T00:00:00Z' WHERE id=$1",[a.checkoutId]);
  row=(await f.query('SELECT send_claimed_at::text,client_reported_at::text FROM user_ton_checkouts WHERE id=$1',[a.checkoutId]))[0];
  expect(Date.parse(row.client_reported_at)).toBeGreaterThan(Date.now()-60000);
  await expect(f.query("UPDATE user_ton_checkouts SET client_reported_at=client_reported_at+interval '1 hour' WHERE id=$1",[a.checkoutId])).rejects.toThrow('TON_CHECKOUT_IMMUTABLE');
 }),120000);

 it('direct SQL claim joins the org/invoice/wallet lock protocol before commit',async()=>withWalletAuthDb(async f=>{
  const x=await ready(f),a=await createTonCheckout(f.db,x.ctx,x.input,()=>policy()),attempt=randomUUID();
  const holder=new Client({connectionString:f.url,ssl:false}),probe=new Client({connectionString:f.url,ssl:false});await holder.connect();await probe.connect();
  try{
   await holder.query('BEGIN');
   await holder.query('UPDATE user_ton_checkouts SET send_attempt_id=$2 WHERE id=$1',[a.checkoutId,attempt]);
   await probe.query('BEGIN');await probe.query("SET LOCAL lock_timeout='150ms'");
   await expect(probe.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[x.ctx.orgId])).rejects.toThrow(/lock timeout|canceling statement/);
   await probe.query('ROLLBACK');await probe.query('BEGIN');await probe.query("SET LOCAL lock_timeout='150ms'");
   await expect(probe.query('SELECT id FROM ton_invoices WHERE id=$1 FOR UPDATE',[a.invoice.invoiceId])).rejects.toThrow(/lock timeout|canceling statement/);
   await probe.query('ROLLBACK');await probe.query('BEGIN');await probe.query("SET LOCAL lock_timeout='150ms'");
   await expect(probe.query('SELECT id FROM user_ton_wallets WHERE id=$1 FOR UPDATE',[x.wallet.id])).rejects.toThrow(/lock timeout|canceling statement/);
   await probe.query('ROLLBACK');
   await holder.query('ROLLBACK');
  }finally{await holder.end();await probe.end();}
 }),120000);

});
