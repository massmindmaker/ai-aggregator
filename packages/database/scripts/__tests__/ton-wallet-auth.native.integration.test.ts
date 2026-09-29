import { createHash } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { withWalletAuthDb } from './ton-wallet-auth.native.fixture';
import { walletProofFixture } from '../../../shared/src/__tests__/ton-wallet-proof.fixture';
import { issueTonWalletChallenge,completeTonWalletProof,consumeTonWalletTicket,listTonWallets,checkTonWalletSession,revokeTonWallet,reserveTonWalletPasswordAttempt } from '../../src/ton-wallet-auth';
const browser='a'.repeat(64),domain='app.example.test';
const bind=(actorUserId:string|null,purpose:'link'|'login')=>({actorUserId,purpose,browserHash:browser,domain});
async function link(f:Parameters<Parameters<typeof withWalletAuthDb>[0]>[0]){
 const context=bind(f.user,'link'),challenge=await issueTonWalletChallenge(f.db,context),proof=walletProofFixture(challenge.payload);
 const result=await completeTonWalletProof(f.db,{...context,challengeId:challenge.challengeId,proof,consent:true});
 if(result.kind!=='linked')throw Error('not linked');return {challenge,proof,context,wallet:result.wallet};
}
describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION==='1')('TON wallet identity durable native lifecycle',()=>{
 it('links a verified known wallet once and returns only owner-scoped public identity',async()=>withWalletAuthDb(async f=>{
  const first=await link(f);const replay=await completeTonWalletProof(f.db,{...first.context,challengeId:first.challenge.challengeId,proof:first.proof,consent:true});
  expect(replay).toMatchObject({kind:'linked',wallet:{id:first.wallet.id,address:first.proof.address}});
  expect(await listTonWallets(f.db,f.user)).toHaveLength(1);expect(await listTonWallets(f.db,f.other)).toEqual([]);
  const raw=(await f.query('SELECT * FROM user_ton_wallet_challenges WHERE id=$1',[first.challenge.challengeId]))[0];expect(JSON.stringify(raw)).not.toContain(first.challenge.payload);expect(raw.consumed_at).not.toBeNull();
  expect((await f.query('SELECT count(*)::int AS n FROM user_ton_wallets'))[0].n).toBe(1);
 }),120000);
 it('refuses consent/cookie/payload/signature/actor tampering before credential creation',async()=>withWalletAuthDb(async f=>{
  const context=bind(f.user,'link'),ch=await issueTonWalletChallenge(f.db,context),proof=walletProofFixture(ch.payload);
  for(const patch of [{consent:false},{browserHash:'b'.repeat(64)},{actorUserId:f.other},{proof:{...proof,proof:{...proof.proof,payload:proof.proof.payload+'x'}}},{proof:{...proof,proof:{...proof.proof,signature:Buffer.alloc(64).toString('base64')}}}])await expect(completeTonWalletProof(f.db,{...context,challengeId:ch.challengeId,proof,consent:true,...patch})).rejects.toBeDefined();
  expect((await f.query('SELECT count(*)::int AS n FROM user_ton_wallets'))[0].n).toBe(0);expect((await f.query('SELECT consumed_at FROM user_ton_wallet_challenges WHERE id=$1',[ch.challengeId]))[0].consumed_at).toBeNull();
 }),120000);
 it('concurrent distinct actors cannot bind the same network address to two accounts',async()=>withWalletAuthDb(async f=>{
  const a=bind(f.user,'link'),b={...bind(f.other,'link'),browserHash:'b'.repeat(64)},ca=await issueTonWalletChallenge(f.db,a),cb=await issueTonWalletChallenge(f.db,b);
  const results=await Promise.allSettled([completeTonWalletProof(f.db,{...a,challengeId:ca.challengeId,proof:walletProofFixture(ca.payload),consent:true}),completeTonWalletProof(f.db,{...b,challengeId:cb.challengeId,proof:walletProofFixture(cb.payload),consent:true})]);
  expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect((await f.query('SELECT count(*)::int AS n FROM user_ton_wallets WHERE revoked_at IS NULL'))[0].n).toBe(1);
 }),120000);
 it('issues a browser-bound one-use login ticket and never returns it again on proof replay',async()=>withWalletAuthDb(async f=>{
  const first=await link(f),context=bind(null,'login'),ch=await issueTonWalletChallenge(f.db,context),proof=walletProofFixture(ch.payload);
  const result=await completeTonWalletProof(f.db,{...context,challengeId:ch.challengeId,proof,consent:false});if(result.kind!=='login_ticket')throw Error('ticket missing');
  expect(JSON.stringify(await f.query('SELECT * FROM user_ton_wallet_challenges WHERE id=$1',[ch.challengeId]))).not.toContain(result.ticket.split('.')[1]);
  await expect(consumeTonWalletTicket(f.db,{ticket:result.ticket,browserHash:'b'.repeat(64)})).rejects.toBeDefined();
  const results=await Promise.allSettled([consumeTonWalletTicket(f.db,{ticket:result.ticket,browserHash:browser}),consumeTonWalletTicket(f.db,{ticket:result.ticket,browserHash:browser})]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  const success=results.find(x=>x.status==='fulfilled');if(success?.status==='fulfilled')expect(success.value).toMatchObject({id:f.user,tonWalletId:first.wallet.id});
  await expect(completeTonWalletProof(f.db,{...context,challengeId:ch.challengeId,proof,consent:false})).rejects.toBeDefined();
 }),120000);
 it('does not sign up unlinked wallets or infer accounts from address/public key',async()=>withWalletAuthDb(async f=>{
  const beforeUsers=await f.query('SELECT id::text FROM users ORDER BY id');
  const context=bind(null,'login'),ch=await issueTonWalletChallenge(f.db,context);
  await expect(completeTonWalletProof(f.db,{...context,challengeId:ch.challengeId,proof:walletProofFixture(ch.payload),consent:false})).rejects.toBeDefined();
  expect((await f.query('SELECT count(*)::int AS n FROM user_ton_wallets'))[0].n).toBe(0);expect(await f.query('SELECT id::text FROM users ORDER BY id')).toEqual(beforeUsers);
 }),120000);
 it('revocation preserves history, invalidates wallet sessions/tickets and rejects foreign or stale password proof',async()=>withWalletAuthDb(async f=>{
  const first=await link(f);expect(await checkTonWalletSession(f.db,f.user,first.wallet.id)).toBe(true);
  await expect(revokeTonWallet(f.db,{actorUserId:f.other,walletId:first.wallet.id,expectedPasswordHash:'fixture-password-hash'})).rejects.toBeDefined();
  await expect(revokeTonWallet(f.db,{actorUserId:f.user,walletId:first.wallet.id,expectedPasswordHash:'old'})).rejects.toBeDefined();
  const context=bind(null,'login'),ch=await issueTonWalletChallenge(f.db,context),ticket=await completeTonWalletProof(f.db,{...context,challengeId:ch.challengeId,proof:walletProofFixture(ch.payload),consent:false});if(ticket.kind!=='login_ticket')throw Error();
  await revokeTonWallet(f.db,{actorUserId:f.user,walletId:first.wallet.id,expectedPasswordHash:'fixture-password-hash'});
  expect(await checkTonWalletSession(f.db,f.user,first.wallet.id)).toBe(false);expect(await listTonWallets(f.db,f.user)).toEqual([]);
  await expect(consumeTonWalletTicket(f.db,{ticket:ticket.ticket,browserHash:browser})).rejects.toBeDefined();expect((await f.query('SELECT count(*)::int AS n FROM user_ton_wallets'))[0].n).toBe(1);
 }),120000);
 it('checks active user again after challenge and refuses expired tickets/proofs',async()=>withWalletAuthDb(async f=>{
  const first=await link(f),context=bind(null,'login'),ch=await issueTonWalletChallenge(f.db,context);
  await f.query('UPDATE users SET is_banned=true WHERE id=$1',[f.user]);await expect(completeTonWalletProof(f.db,{...context,challengeId:ch.challengeId,proof:walletProofFixture(ch.payload),consent:false})).rejects.toBeDefined();expect(await checkTonWalletSession(f.db,f.user,first.wallet.id)).toBe(false);
 }),120000);
 it('bounds challenge and password-attempt issuance rather than allowing unbounded browser retries',async()=>withWalletAuthDb(async f=>{
  for(let n=0;n<8;n++)await issueTonWalletChallenge(f.db,bind(f.user,'link'));
  await expect(issueTonWalletChallenge(f.db,bind(f.user,'link'))).rejects.toThrow('TON_WALLET_RATE_LIMIT');
  for(let n=0;n<8;n++)await reserveTonWalletPasswordAttempt(f.db,f.user);
  await expect(reserveTonWalletPasswordAttempt(f.db,f.user)).rejects.toThrow('TON_WALLET_RATE_LIMIT');
 }),120000);
 it('makes issued challenge and credential identity immutable in SQL',async()=>withWalletAuthDb(async f=>{
  const first=await link(f);
  await expect(f.query("UPDATE user_ton_wallet_challenges SET purpose='login',actor_user_id=NULL WHERE id=$1",[first.challenge.challengeId])).rejects.toThrow('TON_WALLET_CHALLENGE_IMMUTABLE');
  await expect(f.query('UPDATE user_ton_wallets SET user_id=$1 WHERE id=$2',[f.other,first.wallet.id])).rejects.toThrow('TON_WALLET_CREDENTIAL_IMMUTABLE');
 }),120000);
});
