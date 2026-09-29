import { describe,expect,it,vi } from 'vitest';
import { createStoredTranscriptionAttempt } from '../billing/stored-transcription-attempt';

const ids=[
 '11111111-1111-4111-8111-111111111111',
 '22222222-2222-4222-8222-222222222222',
 '33333333-3333-4333-8333-333333333333',
];
const org='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',key='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const identity={
 contractVersion:1 as const,routeKind:'audio_transcription' as const,billingMode:'stored' as const,
 idempotencyKeyDigest:'a'.repeat(64),requestFingerprint:'b'.repeat(64),declaredSessionId:null,
 model:'whisper-large-v3' as const,language:null,audioSha256:'c'.repeat(64),audioBytes:32044,
 sampleRate:16000,channels:1,bitsPerSample:16,frames:16000,durationMs:1000,billableMs:10000,
};
const held=(state:'held'|'dispatched'|'outcome_recorded'|'settled')=>({
 billingRequestId:ids[0],orgId:org,apiKeyId:key,clientRequestId:null,routeKind:'audio_transcription',
 billingMode:'stored',modelSlug:'whisper-large-v3',authorizedMaxCredits:56n,heldSubscriptionCredits:0n,
 heldPaygCredits:56n,capturedSubscriptionExpiresAt:null,quoteSnapshot:{},
 attemptId:state==='held'?null:ids[1],upstreamId:state==='held'?null:'groq',
 pricingSnapshot:state==='held'?null:{},actualCostCredits:['outcome_recorded','settled'].includes(state)?56n:null,
 usageSnapshot:null,outcomeKind:['outcome_recorded','settled'].includes(state)?'success':null,state,
 preDispatchDeadlineAt:'2099-01-01T00:00:00.000000Z',createdAt:'2026-01-01T00:00:00.000000Z',
 dispatchedAt:state==='held'?null:'2026-01-01T00:00:01.000000Z',
 outcomeRecordedAt:['outcome_recorded','settled'].includes(state)?'2026-01-01T00:00:02.000000Z':null,
 settledAt:state==='settled'?'2026-01-01T00:00:03.000000Z':null,cancelledAt:null,reconcileAfter:null,
 releasedSubscriptionCredits:0n,releasedPaygCredits:0n,debtRepaidCredits:0n,expiredSubscriptionCredits:0n,didTransition:true,
});
function job(status:'claimed'|'completed',settledAt:string|null=null){
 return {id:ids[2],taskId:'task_'+ids[2].replaceAll('-',''),billingRequestId:ids[0],
  routeKind:'audio_transcription' as const,status,modelSlug:'whisper-large-v3',upstreamId:'groq',
  providerFamily:'groq_stt' as const,providerTaskId:null,output:status==='completed'?{text:'hello'}:null,errorMessage:null,
  quotedRetailMicrocredits:56n,quotedSupplierMicrocredits:31n,deadlineAt:'2099-01-01T00:00:00.000000Z',settledAt};
}
function setup(overrides:any={}){
 let i=0;
 const deps:any={
  newUuid:()=>ids[i++]!,
  claim:vi.fn().mockResolvedValue({id:ids[2],taskId:job('claimed').taskId,billingRequestId:ids[0],didClaim:true}),
  read:vi.fn().mockResolvedValue(job('completed')),
  releaseClaim:vi.fn().mockResolvedValue(true),
  admit:vi.fn().mockResolvedValue(held('held')),
  dispatch:vi.fn().mockResolvedValue({kind:'dispatch_granted',admission:held('dispatched')}),
  readAdmission:vi.fn().mockResolvedValue(held('dispatched')),
  terminal:vi.fn().mockResolvedValue({state:'dispatched',didRecord:true}),
  outcome:vi.fn().mockResolvedValue(held('outcome_recorded')),
  settle:vi.fn().mockResolvedValue(held('settled')),
  execute:vi.fn().mockResolvedValue({text:'hello',providerDurationMs:1000,providerResponseId:'resp_1'}),
  ...overrides,
 };
 const attempt=createStoredTranscriptionAttempt({
  identity,audioBytes:new Uint8Array([1,2,3]),orgId:org,apiKeyId:key,clientRequestId:null,
  deadlineAt:'2099-01-01T00:00:00.000000Z',modelSlug:'whisper-large-v3',
  modelUpstreamId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',upstreamId:'groq',upstreamModelId:'whisper-large-v3',
  quote:{billableMs:10000,supplierRateUsdMicroPerHour:111000,supplierMaxUsdMicro:309n,
    supplierMaxMicrocredits:31n,retailMaxMicrocredits:56n,
    formulaVersion:'groq-whisper-duration-v1',supplierFormulaVersion:'groq-whisper-duration-usd-micro-v1'},
  markup:'1.8',execute:deps.execute,
 },deps);
 return {attempt,deps};
}
describe('stored transcription exactly-once provider boundary',()=>{
 it('fresh claim calls provider once, persists terminal evidence, settles, then marks durable settled replay',async()=>{
  const s=setup();
  expect(await s.attempt.run()).toEqual({kind:'completed',taskId:job('claimed').taskId,billingRequestId:ids[0],text:'hello'});
  expect(s.deps.execute).toHaveBeenCalledTimes(1);
  expect(s.deps.terminal).toHaveBeenCalledTimes(2);
  expect(s.deps.settle).toHaveBeenCalledTimes(1);
  expect(await s.attempt.run()).toMatchObject({kind:'completed',text:'hello'});
  expect(s.deps.execute).toHaveBeenCalledTimes(1);
 });
 it('never calls provider when dispatch is a replay rather than a fresh transition',async()=>{
  const s=setup({dispatch:vi.fn().mockResolvedValue({kind:'replay',admission:held('dispatched')})});
  expect(await s.attempt.run()).toMatchObject({kind:'reconciliation_required',stage:'dispatch'});
  expect(s.deps.execute).not.toHaveBeenCalled();
 });
 it('recovers an admitted pre-dispatch replay by obtaining a fresh dispatch grant exactly once',async()=>{
  const readAdmission=vi.fn().mockResolvedValueOnce(held('held')).mockResolvedValue(held('dispatched'));
  const s=setup({readAdmission});
  s.deps.claim.mockResolvedValueOnce({id:ids[2],taskId:job('claimed').taskId,billingRequestId:ids[0],didClaim:false});
  s.deps.read.mockResolvedValueOnce(job('claimed'));
  expect(await s.attempt.run()).toMatchObject({kind:'completed',text:'hello'});
  expect(s.deps.admit).not.toHaveBeenCalled();expect(s.deps.dispatch).toHaveBeenCalledTimes(1);expect(s.deps.execute).toHaveBeenCalledTimes(1);
 });
 it('never calls provider for an existing claimed replay already durably dispatched',async()=>{
  const s=setup({admit:vi.fn().mockResolvedValue(held('dispatched'))});
  s.deps.claim.mockResolvedValueOnce({id:ids[2],taskId:job('claimed').taskId,billingRequestId:ids[0],didClaim:false});
  s.deps.read.mockResolvedValueOnce(job('claimed'));
  expect(await s.attempt.run()).toMatchObject({kind:'reconciliation_required',stage:'provider'});
  expect(s.deps.dispatch).not.toHaveBeenCalled();expect(s.deps.execute).not.toHaveBeenCalled();
 });
 it('replays completed durable transcript by settling only, without provider call',async()=>{
  const s=setup();
  s.deps.claim.mockResolvedValueOnce({id:ids[2],taskId:job('claimed').taskId,billingRequestId:ids[0],didClaim:false});
  s.deps.read.mockResolvedValueOnce(job('completed'));
  expect(await s.attempt.run()).toEqual({kind:'completed',taskId:job('claimed').taskId,billingRequestId:ids[0],text:'hello'});
  expect(s.deps.execute).not.toHaveBeenCalled();expect(s.deps.settle).toHaveBeenCalledTimes(1);expect(s.deps.terminal).toHaveBeenCalledTimes(1);
 });
 it('does not trust job settled_at when durable admission is not settled',async()=>{
  const s=setup({readAdmission:vi.fn().mockResolvedValue(held('dispatched'))});
  s.deps.claim.mockResolvedValueOnce({id:ids[2],taskId:job('claimed').taskId,billingRequestId:ids[0],didClaim:false});
  s.deps.read.mockResolvedValueOnce(job('completed','2026-01-01T00:00:03.000000Z'));
  expect(await s.attempt.run()).toMatchObject({kind:'reconciliation_required',stage:'outcome'});
  expect(s.deps.execute).not.toHaveBeenCalled();expect(s.deps.settle).not.toHaveBeenCalled();
 });
 it('returns completed replay immediately once settled_at and admission are both durable',async()=>{
  const s=setup({readAdmission:vi.fn().mockResolvedValue(held('settled'))});
  s.deps.claim.mockResolvedValueOnce({id:ids[2],taskId:job('claimed').taskId,billingRequestId:ids[0],didClaim:false});
  s.deps.read.mockResolvedValueOnce(job('completed','2026-01-01T00:00:03.000000Z'));
  expect(await s.attempt.run()).toMatchObject({kind:'completed',text:'hello'});
  expect(s.deps.execute).not.toHaveBeenCalled();expect(s.deps.settle).not.toHaveBeenCalled();expect(s.deps.terminal).not.toHaveBeenCalled();
 });
 it('rejects mismatched provider duration after one POST without persisting or retrying',async()=>{
  const s=setup({execute:vi.fn().mockResolvedValue({text:'hello',providerDurationMs:9000,providerResponseId:'resp_1'})});
  expect(await s.attempt.run()).toMatchObject({kind:'reconciliation_required',stage:'provider'});
  expect(s.deps.execute).toHaveBeenCalledTimes(1);expect(s.deps.terminal).not.toHaveBeenCalled();
 });
 it('keeps provider throw as unknown reconciliation and never writes zero-charge failure',async()=>{
  const s=setup({execute:vi.fn().mockRejectedValue(new Error('lost response'))});
  expect(await s.attempt.run()).toMatchObject({kind:'reconciliation_required',stage:'provider'});
  expect(s.deps.terminal).not.toHaveBeenCalled();expect(s.deps.settle).not.toHaveBeenCalled();
 });
 it('keeps committed terminal with lost ACK out of provider retry path',async()=>{
  const s=setup({terminal:vi.fn().mockRejectedValue(new Error('lost terminal ack'))});
  expect(await s.attempt.run()).toMatchObject({kind:'reconciliation_required',stage:'outcome'});
  expect(s.deps.execute).toHaveBeenCalledTimes(1);expect(s.deps.settle).not.toHaveBeenCalled();
 });
 it('releases only a definitely unadmitted claim',async()=>{
  const failure=new Error('insufficient');
  const s=setup({admit:vi.fn().mockRejectedValue(failure)});
  await expect(s.attempt.run()).rejects.toBe(failure);
  expect(s.deps.releaseClaim).toHaveBeenCalledTimes(1);expect(s.deps.execute).not.toHaveBeenCalled();
 });
});
