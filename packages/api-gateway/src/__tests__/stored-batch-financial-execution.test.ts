import { describe, expect, it, vi } from 'vitest';
import { executeStoredBatchFinancial, type StoredBatchFinancialDependencies } from '../billing/stored-batch-financial-execution';
import { prepareStoredChatExecution } from '../billing/stored-chat-execution-preparation';
import { prepareStoredEmbeddingsExecution } from '../billing/stored-embeddings-execution-preparation';
import { AdmissionDeadlineExpiredError } from '../billing/admission';
import { captureStoredChatEvidence } from '../billing/stored-chat-attempt-contract';
import type { StoredBatchWorkerItem } from '../billing/stored-batch-storage';
import type { GatewayChargeAdmissionResult } from '../billing/admission-result';
import type { StoredBatchRuntimePreparation } from '../batch-runtime';
import type { AdmittedChatResponse, AdmittedChatUsage } from '../upstreams/interface';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const uuid = (n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now = new Date('2026-09-27T12:00:00.000Z');
const deadline = '2026-09-27T13:00:00.000000Z';

function chatModel(){ return {slug:'openai/gpt-4o-mini',type:'chat',candidates:[{
  id:'openrouter',upstream_id:'openrouter',upstream_model_id:'openai/gpt-4o-mini',provider:'openai',
  price_per_1k_input:1,price_per_1k_output:1,markup:999,latency_p50_ms:1,uptime:1,ru_residency:false,
  billing:{modelUpstreamId:uuid(3),prices:{inputCentsPer1k:'0.123456789012345678',outputCentsPer1k:'0.5',markup:'1.25'}},
}]}; }

function output(): Readonly<{response:AdmittedChatResponse;usage:AdmittedChatUsage}>{ return {response:{id:'gen-1',object:'chat.completion',created:1,model:'reported/alias',choices:[{index:0,message:{role:'assistant',content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}},usage:{promptTokens:100,completionTokens:20,totalTokens:120,cachedInputTokens:50}}; }
function embeddingModel(){ return {slug:'openai/text-embedding-3-small',type:'embedding',candidates:[{id:'openrouter',upstream_id:'openrouter',upstream_model_id:'openai/text-embedding-3-small',provider:'openai',price_per_1k_input:999,price_per_1k_output:999,markup:999,latency_p50_ms:1,uptime:1,ru_residency:false,billing:{modelUpstreamId:uuid(4),prices:{inputCentsPer1k:'0.002',outputCentsPer1k:'0',markup:'1.25'}}}]}; }
function embeddingOutput(){ const vector=Array(1536).fill(0.25); return {response:{object:'list',model:'openai/text-embedding-3-small',data:[{object:'embedding',index:0,embedding:vector},{object:'embedding',index:1,embedding:vector}],usage:{prompt_tokens:1000,total_tokens:1000}},usage:{promptTokens:1000,totalTokens:1000,providerResponseId:'emb-1'}}; }

function admission(prepared:any,state:GatewayChargeAdmissionResult['state']='held'):GatewayChargeAdmissionResult {
  return {billingRequestId:prepared.billingRequestId,orgId:uuid(1),apiKeyId:uuid(2),clientRequestId:null,routeKind:prepared.routeKind,billingMode:'stored',modelSlug:'openai/gpt-4o-mini',authorizedMaxCredits:prepared.admissionArgs.authorizedMaxCredits,heldSubscriptionCredits:prepared.admissionArgs.authorizedMaxCredits,heldPaygCredits:0n,capturedSubscriptionExpiresAt:null,quoteSnapshot:prepared.admissionArgs.quoteSnapshot,attemptId:state==='held'?null:prepared.attemptId,upstreamId:state==='held'?null:'openrouter',pricingSnapshot:state==='held'?null:prepared.pricingSnapshot,actualCostCredits:null,usageSnapshot:null,outcomeKind:null,state,preDispatchDeadlineAt:prepared.admissionArgs.preDispatchDeadlineAt,createdAt:'2026-09-27T11:00:00.000000Z',dispatchedAt:null,outcomeRecordedAt:null,settledAt:null,cancelledAt:null,reconcileAfter:null,releasedSubscriptionCredits:0n,releasedPaygCredits:0n,debtRepaidCredits:0n,expiredSubscriptionCredits:0n,didTransition:state!=='held'};
}

function setup(overrides:Partial<{deadline:string;pricing:Record<string,unknown>;adapterExecute:(r:unknown)=>unknown;routeKind:'chat'|'completions'}>={}){
  const execute=vi.fn(overrides.adapterExecute??(async()=>output()));
  const prepared=prepareStoredChatExecution({orgId:uuid(1),apiKeyId:uuid(2),clientRequestId:null,declaredSessionId:null,model:chatModel() as any,requestedMode:'fastest',policy:{},body:{model:'openai/gpt-4o-mini',messages:[{role:'user',content:'hello'}]},defaultMaxOutputTokens:4096,cachingDiscount:'0.5',preDispatchDeadlineAt:overrides.deadline??deadline},{admissionRouteKind:overrides.routeKind??'chat',getAdapter:()=>({admittedChat:{contract:'openrouter-pinned-provider-chat-v1',execute},chat:async()=>{throw new Error('legacy');}} as any),newUuid:(()=>{let n=10;return()=>uuid(n++);})()});
  if(prepared.status!=='ready') throw new Error('fixture preparation failed');
  const item={id:uuid(20),parentId:uuid(21),batchId:'batch_0123456789abcdef0123456789abcdef',itemIndex:0,customId:'c1',routeKind:prepared.routeKind,requestFingerprint:'a'.repeat(64),requestBody:{model:'openai/gpt-4o-mini',messages:[{role:'user',content:'hello'}]},billingRequestId:prepared.billingRequestId,attemptId:prepared.attemptId,modelSlug:'openai/gpt-4o-mini',modelUpstreamId:prepared.modelUpstreamId,upstreamId:prepared.upstreamId,upstreamModelId:prepared.upstreamModelId,adapterKey:prepared.adapterKey,pricingSnapshot:{...prepared.pricingSnapshot,...(overrides.pricing??{})},providerRequest:prepared.providerRequest,status:'processing',deadlineAt:overrides.deadline??deadline,admission:admission(prepared)} as StoredBatchWorkerItem;
  const runtime={item,adapter:{contract:prepared.adapterContract,execute},request:prepared.providerRequest} as unknown as StoredBatchRuntimePreparation;
  const evidence=captureStoredChatEvidence(output(),prepared.candidate,prepared.cachingDiscount,prepared.billingRequestId,prepared.attemptId);
  const dispatched:GatewayChargeAdmissionResult={...admission(prepared,'dispatched'),didTransition:true};
  const recorded:GatewayChargeAdmissionResult={...dispatched,state:'outcome_recorded',pricingSnapshot:item.pricingSnapshot,actualCostCredits:evidence.actualCostCredits,usageSnapshot:evidence.usageSnapshot,outcomeKind:'success'};
  const settled:GatewayChargeAdmissionResult={...recorded,state:'settled',settledAt:'2026-09-27T12:00:01.123456Z'};
  const deps:Mutable<StoredBatchFinancialDependencies>={now:()=>now,markGatewayChargeDispatched:vi.fn(async()=>({kind:'dispatch_granted' as const,admission:dispatched})),recordStoredBatchPendingEvidence:vi.fn(async()=>undefined),recordGatewayChargeOutcomeV2:vi.fn(async()=>recorded),settleAdmittedGatewayCharge:vi.fn(async()=>settled),cancelUndispatchedGatewayCharge:vi.fn(async()=>({...admission(prepared,'cancelled'),billingRequestId:prepared.billingRequestId,state:'cancelled' as const,didTransition:true}))};
  return {item,runtime,execute,deps,settled,dispatched,evidence};
}

describe('stored batch financial execution',()=>{
  it('settles valid chat with persisted tariff facts, digest and DB settledAt',async()=>{
    const s=setup();
    const result=await executeStoredBatchFinancial(s.item,s.runtime,s.deps);
    expect(result.kind).toBe('settled_success');
    expect(result).toMatchObject({settledAt:s.settled.settledAt});
    expect((result as any).resultDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.deps.recordStoredBatchPendingEvidence).toHaveBeenCalledWith(s.item.id,expect.objectContaining({actualCostCredits:s.evidence.actualCostCredits}));
    expect(vi.mocked(s.deps.recordStoredBatchPendingEvidence).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(s.deps.recordGatewayChargeOutcomeV2).mock.invocationCallOrder[0]!);
    expect(s.deps.recordGatewayChargeOutcomeV2).toHaveBeenCalledWith(expect.objectContaining({actualCostCredits:s.evidence.actualCostCredits}));
  });

  it('cancels expired held work before dispatch and provider',async()=>{
    const s=setup({deadline:'2026-09-27T11:59:59.000000Z'});
    const result=await executeStoredBatchFinancial(s.item,s.runtime,s.deps);
    expect(result).toEqual({kind:'cancelled_no_charge',errorCode:'BATCH_ITEM_EXPIRED'});
    expect(s.execute).not.toHaveBeenCalled(); expect(s.deps.markGatewayChargeDispatched).not.toHaveBeenCalled();
  });

  it('defers temporary mechanics unavailability without releasing the hold',async()=>{
    const s=setup(); const result=await executeStoredBatchFinancial(s.item,null,s.deps);
    expect(result).toEqual({kind:'retry_later',retryAt:'2026-09-27T12:00:05.000Z'});
    expect(s.deps.cancelUndispatchedGatewayCharge).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
  });

  it('does not redispatch a dispatch replay',async()=>{
    const s=setup(); s.deps.markGatewayChargeDispatched=vi.fn(async()=>({kind:'replay' as const,admission:s.dispatched}));
    const result=await executeStoredBatchFinancial(s.item,s.runtime,s.deps);
    expect(result).toEqual({kind:'reconciliation_required',errorCode:'DISPATCH_REPLAY'}); expect(s.execute).not.toHaveBeenCalled();
  });

  it('defers pinned profile unavailability before provider dispatch',async()=>{
    const s=setup({pricing:{profileId:'tampered'}});
    const result=await executeStoredBatchFinancial(s.item,s.runtime,s.deps);
    expect(result).toEqual({kind:'retry_later',retryAt:'2026-09-27T12:00:05.000Z'});
    expect(s.deps.cancelUndispatchedGatewayCharge).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled(); expect(s.deps.markGatewayChargeDispatched).not.toHaveBeenCalled();
  });

  it('retains reconciliation on provider or settlement ambiguity without redispatch',async()=>{
    const s=setup({adapterExecute:async()=>{throw new Error('timeout-after-provider');}});
    const result=await executeStoredBatchFinancial(s.item,s.runtime,s.deps);
    expect(result).toEqual({kind:'reconciliation_required',errorCode:'PROVIDER_OR_USAGE_UNCONFIRMED'});
    expect(s.execute).toHaveBeenCalledTimes(1); expect(s.deps.markGatewayChargeDispatched).toHaveBeenCalledTimes(1);
  });

  it('settles embeddings with the pinned 1536-dimension evidence contract',async()=>{
    const execute=vi.fn(async()=>embeddingOutput());
    const prepared=prepareStoredEmbeddingsExecution({orgId:uuid(1),apiKeyId:uuid(2),clientRequestId:null,declaredSessionId:null,model:embeddingModel() as any,requestedMode:'fastest',policy:{},body:{model:'openai/text-embedding-3-small',input:['first','second'],encoding_format:'float',dimensions:1536},preDispatchDeadlineAt:deadline},{getAdapter:()=>({admittedEmbeddings:{contract:'openrouter-pinned-provider-embeddings-v1',execute},chat:async()=>{throw new Error('legacy');}} as any),newUuid:(()=>{let n=30;return()=>uuid(n++);})()});
    expect(prepared.status).toBe('ready'); if(prepared.status!=='ready') throw new Error('embedding fixture preparation failed');
    const item={id:uuid(31),parentId:uuid(32),batchId:'batch_0123456789abcdef0123456789abcdef',itemIndex:0,customId:'e1',routeKind:'embeddings',requestFingerprint:'b'.repeat(64),requestBody:{model:prepared.normalizedBody.modelSlug,input:prepared.normalizedBody.input},billingRequestId:prepared.billingRequestId,attemptId:prepared.attemptId,modelSlug:prepared.normalizedBody.modelSlug,modelUpstreamId:prepared.modelUpstreamId,upstreamId:prepared.upstreamId,upstreamModelId:prepared.upstreamModelId,adapterKey:prepared.adapterKey,pricingSnapshot:prepared.pricingSnapshot,providerRequest:prepared.providerRequest,status:'processing',deadlineAt:deadline,admission:{...admission(prepared),modelSlug:prepared.normalizedBody.modelSlug}} as StoredBatchWorkerItem;
    const runtime={item,adapter:{contract:prepared.adapterContract,execute},request:prepared.providerRequest} as unknown as StoredBatchRuntimePreparation;
    const d=setup().deps; const dispatched=admission(prepared,'dispatched');
    d.markGatewayChargeDispatched=vi.fn(async()=>({kind:'dispatch_granted' as const,admission:{...dispatched,didTransition:true}}));
    d.recordGatewayChargeOutcomeV2=vi.fn(async(args:Parameters<StoredBatchFinancialDependencies['recordGatewayChargeOutcomeV2']>[0])=>({...dispatched,state:'outcome_recorded' as const,didTransition:true,attemptId:prepared.attemptId,upstreamId:prepared.upstreamId,pricingSnapshot:prepared.pricingSnapshot,actualCostCredits:args.actualCostCredits,usageSnapshot:args.usageSnapshot,outcomeKind:'success'}));
    d.settleAdmittedGatewayCharge=vi.fn(async(args:Parameters<StoredBatchFinancialDependencies['settleAdmittedGatewayCharge']>[0])=>({...args.admission,state:'settled' as const,settledAt:'2026-09-27T12:00:01.000000Z',didTransition:true}));
    const result=await executeStoredBatchFinancial(item,runtime,d);
    expect(result.kind).toBe('settled_success'); expect(execute).toHaveBeenCalledTimes(1);
  });

  it('holds reconciliation when usage evidence is invalid after provider',async()=>{
    const s=setup({adapterExecute:async()=>({...output(),usage:{promptTokens:100,completionTokens:20,totalTokens:119,cachedInputTokens:50}})});
    const result=await executeStoredBatchFinancial(s.item,s.runtime,s.deps);
    expect(result).toEqual({kind:'reconciliation_required',errorCode:'PROVIDER_OR_USAGE_UNCONFIRMED'});
    expect(s.deps.recordGatewayChargeOutcomeV2).not.toHaveBeenCalled();
  });

  it('keeps the hold when durable evidence ACK is unknown after provider',async()=>{
    const s=setup();
    s.deps.recordStoredBatchPendingEvidence=vi.fn(async()=>{throw new Error('lost evidence ACK');});
    const result=await executeStoredBatchFinancial(s.item,s.runtime,s.deps);
    expect(result).toEqual({kind:'reconciliation_required',errorCode:'EVIDENCE_UNCONFIRMED'});
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.deps.recordGatewayChargeOutcomeV2).not.toHaveBeenCalled();
  });

  it('keeps reconciliation when outcome ACK is not confirmed',async()=>{
    const s=setup(); s.deps.recordGatewayChargeOutcomeV2=vi.fn(async()=>({...s.dispatched,state:'outcome_recorded',didTransition:true} as GatewayChargeAdmissionResult));
    const result=await executeStoredBatchFinancial(s.item,s.runtime,s.deps);
    expect(result.kind).toBe('reconciliation_required'); expect(['OUTCOME_UNCONFIRMED','OUTCOME_OR_SETTLE_UNCONFIRMED']).toContain((result as any).errorCode); expect(s.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps reconciliation when settle ACK is not confirmed',async()=>{
    const s=setup(); s.deps.settleAdmittedGatewayCharge=vi.fn(async()=>({...s.settled,settledAt:null} as GatewayChargeAdmissionResult));
    const result=await executeStoredBatchFinancial(s.item,s.runtime,s.deps);
    expect(result).toEqual({kind:'reconciliation_required',errorCode:'SETTLE_UNCONFIRMED'});
  });

  it('defers pinned snapshot drift before provider without charging',async()=>{
    const s=setup({pricing:{maxCredits:'999999'}});
    const result=await executeStoredBatchFinancial(s.item,s.runtime,s.deps);
    expect(result.kind).toBe('retry_later'); expect(s.execute).not.toHaveBeenCalled(); expect(s.deps.markGatewayChargeDispatched).not.toHaveBeenCalled();
  });

  it('maps an admission deadline race to no-charge cancellation',async()=>{
    const s=setup(); s.deps.markGatewayChargeDispatched=vi.fn(async()=>{throw new AdmissionDeadlineExpiredError();});
    const result=await executeStoredBatchFinancial(s.item,s.runtime,s.deps);
    expect(result).toEqual({kind:'cancelled_no_charge',errorCode:'BATCH_ITEM_EXPIRED'}); expect(s.execute).not.toHaveBeenCalled();
  });

  it('settles completions through the same pinned chat financial path',async()=>{
    const s=setup({routeKind:'completions'});
    const result=await executeStoredBatchFinancial(s.item,s.runtime,s.deps);
    expect(result.kind).toBe('settled_success'); expect(s.execute).toHaveBeenCalledTimes(1);
  });
});
