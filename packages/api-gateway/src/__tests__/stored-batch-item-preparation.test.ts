import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  prepareStoredChatExecution,
  capturePinnedStoredChatEvidence,
} from '../billing/stored-chat-execution-preparation';
import {
  prepareStoredEmbeddingsExecution,
  capturePinnedStoredEmbeddingsEvidence,
} from '../billing/stored-embeddings-execution-preparation';
import { prepareStoredBatchItems } from '../billing/stored-batch-item-preparation';
import { captureStoredBatchHttpIdentity } from '../billing/stored-batch-http-identity';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';
import type { AdmittedChatRequest, AdmittedEmbeddingsRequest } from '../upstreams/interface';

const uuid = (n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const deadline='2026-09-27T20:00:00.000000Z';

const chatModel = () => ({
  slug:'openai/gpt-4o-mini', type:'chat',
  candidates:[{
    id:'openrouter', upstream_id:'openrouter', upstream_model_id:'openai/gpt-4o-mini',
    provider:'openai', price_per_1k_input:1, price_per_1k_output:1, markup:999,
    latency_p50_ms:1, uptime:1, ru_residency:false,
    billing:{modelUpstreamId:uuid(3),prices:{inputCentsPer1k:'0.123456789012345678',outputCentsPer1k:'0.5',markup:'1.25'}},
  }],
}) as any;
const embeddingModel = () => ({
  slug:'openai/text-embedding-3-small', type:'embedding',
  candidates:[{
    id:'openrouter', upstream_id:'openrouter', upstream_model_id:'openai/text-embedding-3-small',
    provider:'openai', price_per_1k_input:999, price_per_1k_output:999, markup:999,
    latency_p50_ms:1, uptime:1, ru_residency:false,
    billing:{modelUpstreamId:uuid(4),prices:{inputCentsPer1k:'0.002',outputCentsPer1k:'0',markup:'1.25'}},
  }],
}) as any;

function adapters(){
  return {
    chat:{
      admittedChat:{contract:'openrouter-pinned-provider-chat-v1',execute:vi.fn(async (_r:AdmittedChatRequest)=>chatOutput())},
      chat:vi.fn(),
    },
    embeddings:{
      admittedEmbeddings:{contract:'openrouter-pinned-provider-embeddings-v1',execute:vi.fn(async (_r:AdmittedEmbeddingsRequest)=>embeddingOutput())},
      chat:vi.fn(),
    },
  };
}
function chatOutput(){
  return {
    response:{
      id:'gen-1',object:'chat.completion' as const,created:1,model:'reported/alias',
      choices:[{index:0,message:{role:'assistant' as const,content:'answer'},finish_reason:'stop' as const}],
      usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120},
    },
    usage:{promptTokens:100,completionTokens:20,totalTokens:120,cachedInputTokens:50},
  };
}
function embeddingOutput(){
  const vector=Array(1536).fill(0.25);
  return {
    response:{
      object:'list' as const,model:'openai/text-embedding-3-small',
      data:[
        {object:'embedding' as const,index:0,embedding:vector},
        {object:'embedding' as const,index:1,embedding:vector},
      ],
      usage:{prompt_tokens:1000,total_tokens:1000},
    },
    usage:{promptTokens:1000,totalTokens:1000,providerResponseId:'emb-1' as string|null},
  };
}
const key:AuthenticatedApiKey={
  id:uuid(2),org_id:uuid(1),policies:{},rpm_limit:100,daily_usd_cap:null,batch_rpm_limit:100,
  model_whitelist:[],ru_residency_only:false,
};

describe('stored batch item execution preparation',()=>{
  it('keeps direct attempts on the same shared preparation and pinned evidence path',()=>{
    const chat=readFileSync(new URL('../billing/stored-chat-attempt.ts', import.meta.url),'utf8');
    const embeddings=readFileSync(new URL('../billing/stored-embeddings-attempt.ts', import.meta.url),'utf8');
    expect(chat).toContain('prepareStoredChatExecution(');
    expect(chat).toContain('capturePinnedStoredChatEvidence(');
    expect(embeddings).toContain('prepareStoredEmbeddingsExecution(');
    expect(embeddings).toContain('capturePinnedStoredEmbeddingsEvidence(');
  });
  it('pins chat and completions to the same exact direct-route financial/provider authority',()=>{
    let next=10;
    const a=adapters();
    const base={
      orgId:uuid(1),apiKeyId:uuid(2),clientRequestId:'trace',declaredSessionId:'SID',
      model:chatModel(),requestedMode:'fastest' as const,policy:{},
      body:{model:'openai/gpt-4o-mini',messages:[{role:'user',content:'hello'}]},
      defaultMaxOutputTokens:4096,cachingDiscount:'0.5',preDispatchDeadlineAt:deadline,
    };
    const chat=prepareStoredChatExecution(base,{getAdapter:()=>a.chat as any,newUuid:()=>uuid(next++)});
    expect(chat.status).toBe('ready');
    if(chat.status!=='ready') throw new Error(chat.status);
    next=10;
    const completion=prepareStoredChatExecution({
      ...base,
      body:{model:'openai/gpt-4o-mini',messages:[{role:'user',content:'hello'}],stream:false},
    },{admissionRouteKind:'completions',getAdapter:()=>a.chat as any,newUuid:()=>uuid(next++)});
    expect(completion.status).toBe('ready');
    if(completion.status!=='ready') throw new Error(completion.status);

    expect(chat.admissionArgs.routeKind).toBe('chat');
    expect(completion.admissionArgs.routeKind).toBe('completions');
    expect(completion.admissionArgs.authorizedMaxCredits).toBe(chat.admissionArgs.authorizedMaxCredits);
    expect(completion.admissionArgs.quoteSnapshot).toEqual(chat.admissionArgs.quoteSnapshot);
    expect(completion.admissionArgs.supplierQuoteSnapshot).toEqual(chat.admissionArgs.supplierQuoteSnapshot);
    expect(completion.pricingSnapshot).toEqual(chat.pricingSnapshot);
    expect(completion.providerRequest).toEqual(chat.providerRequest);
    expect(JSON.stringify(chat, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain('private-key');
  });

  it('pins embeddings exact quote, provider request and evidence without mutable catalog pricing',()=>{
    let next=20;
    const a=adapters();
    const prepared=prepareStoredEmbeddingsExecution({
      orgId:uuid(1),apiKeyId:uuid(2),clientRequestId:'trace',declaredSessionId:'SID',
      model:embeddingModel(),requestedMode:'fastest',policy:{},
      body:{model:'openai/text-embedding-3-small',input:['first','second'],encoding_format:'float',dimensions:1536},
      preDispatchDeadlineAt:deadline,
    },{getAdapter:()=>a.embeddings as any,newUuid:()=>uuid(next++)});
    expect(prepared.status).toBe('ready');
    if(prepared.status!=='ready') throw new Error(prepared.status);
    expect(prepared.admissionArgs.routeKind).toBe('embeddings');
    expect(prepared.admissionArgs.authorizedMaxCredits).toBe(41n);
    expect(prepared.providerRequest).toEqual({
      modelId:'openai/text-embedding-3-small',input:['first','second'],
      endpointPolicy:{only:['openai'],allowFallbacks:false,requireParameters:true},
    });
    const evidence=capturePinnedStoredEmbeddingsEvidence(embeddingOutput(),prepared);
    expect(evidence.actualCostCredits).toBe(3n);
    expect(()=>capturePinnedStoredEmbeddingsEvidence({
      ...embeddingOutput(),
      usage:{promptTokens:1000,totalTokens:999,providerResponseId:null},
    },prepared)).toThrow();
  });

  it('batch preparation matches direct preparation for chat, embeddings and completions',async()=>{
    let next=30;
    const a=adapters();
    const combined={...a.chat,...a.embeddings};
    const deps={
      resolveChatModel:async()=>chatModel(),
      resolveEmbeddingsModel:async()=>embeddingModel(),
      evaluateChatPolicy:({model}:any)=>({model,policy:{},requestedMode:'fastest'}),
      evaluateEmbeddingsPolicy:({model}:any)=>({model,policy:{},requestedMode:'fastest'}),
      getAdapter:()=>combined as any,
      newUuid:()=>uuid(next++),
      cachingDiscount:'0.5',
      defaultMaxOutputTokens:4096,
    };
    const cases=[
      {
        type:'chat' as const, customId:'c1',
        body:{model:'openai/gpt-4o-mini',messages:[{role:'user',content:'hello'}]},
        routeKind:'chat', provider:{modelId:'openai/gpt-4o-mini',maxTokens:4096},
      },
      {
        type:'embeddings' as const, customId:'e1',
        body:{model:'openai/text-embedding-3-small',input:['first','second'],encoding_format:'float',dimensions:1536},
        routeKind:'embeddings', provider:{modelId:'openai/text-embedding-3-small',input:['first','second']},
      },
      {
        type:'completions' as const, customId:'p1',
        body:{model:'openai/gpt-4o-mini',prompt:'hello'},
        routeKind:'completions', provider:{modelId:'openai/gpt-4o-mini',maxTokens:4096},
      },
    ];
    for(const c of cases){
      const identity=captureStoredBatchHttpIdentity({
        idempotencyKey:'batch-'+c.customId,declaredSessionId:'SID',byokKeyPresent:false,
        body:{type:c.type,requests:[{custom_id:c.customId,body:c.body}]},
      });
      const batch=await prepareStoredBatchItems({identity,key,requestId:'trace',deadlineAt:deadline},deps);
      expect(batch).toHaveLength(1);
      const item=batch[0]!;
      expect(item.customId).toBe(c.customId);
      expect(item.execution.status).toBe('ready');
      if(item.execution.status!=='ready') throw new Error(item.execution.status);
      expect(item.execution.admissionArgs.routeKind).toBe(c.routeKind);
      expect(item.execution.providerRequest).toMatchObject(c.provider);
      expect(item.execution.admissionArgs.supplierQuoteSnapshot).toMatchObject({
        version:2,formulaVersion:'catalog-input-output-cents-per-1k-usd-micro-v2',
      });
    }
  });

  it('pinned chat evidence rejects a usage shape direct execution rejects',()=>{
    let next=40;
    const a=adapters();
    const prepared=prepareStoredChatExecution({
      orgId:uuid(1),apiKeyId:uuid(2),clientRequestId:'trace',declaredSessionId:null,
      model:chatModel(),requestedMode:'fastest',policy:{},
      body:{model:'openai/gpt-4o-mini',messages:[{role:'user',content:'hello'}]},
      defaultMaxOutputTokens:4096,cachingDiscount:'0.5',preDispatchDeadlineAt:deadline,
    },{getAdapter:()=>a.chat as any,newUuid:()=>uuid(next++)});
    expect(prepared.status).toBe('ready');
    if(prepared.status!=='ready') throw new Error(prepared.status);
    expect(capturePinnedStoredChatEvidence(chatOutput(),prepared).actualCostCredits).toBe(21n);
    expect(()=>capturePinnedStoredChatEvidence({
      ...chatOutput(),usage:{promptTokens:100,completionTokens:20,totalTokens:119,cachedInputTokens:50},
    },prepared)).toThrow();
  });
});
