import { describe, expect, it, vi } from 'vitest';
import { preparePinnedStoredBatchRuntime } from '../batch-runtime';

const item = (routeKind: 'chat'|'embeddings'|'completions' = 'chat'): any => ({
  id:'00000000-0000-4000-8000-000000000001', parentId:'00000000-0000-4000-8000-000000000002', batchId:'batch_00000000000000000000000000000001', itemIndex:0, customId:'x', routeKind,
  requestFingerprint:'a'.repeat(64), requestBody: routeKind === 'embeddings' ? {input:['hello']} : {messages:[{role:'user',content:'hello'}],max_tokens:16}, providerRequest: routeKind === 'embeddings' ? {modelId:'m',input:['hello'],endpointPolicy:{only:['openai'],allowFallbacks:false,requireParameters:true}} : {modelId:'m',messages:[{role:'user',content:'hello'}],maxTokens:16,endpointPolicy:{only:['openai'],allowFallbacks:false,requireParameters:true}}, billingRequestId:'00000000-0000-4000-8000-000000000003', attemptId:'00000000-0000-4000-8000-000000000004', modelSlug:'m', modelUpstreamId:'00000000-0000-4000-8000-000000000005', upstreamId:'m', upstreamModelId:'m', adapterKey:'openrouter', pricingSnapshot:{endpointPolicy:{only:['openai'],allowFallbacks:false,requireParameters:true},maxOutputTokens:16,adapterContract: routeKind === 'embeddings' ? 'openrouter-pinned-provider-embeddings-v1' : 'openrouter-pinned-provider-chat-v1'}, status:'queued', deadlineAt:'2030-01-01T00:00:00.000Z', admission:{}
});

describe('batch runtime boundary', () => {
  it('rejects missing or mismatched admitted mechanics before dispatch', () => {
    expect(preparePinnedStoredBatchRuntime(item(), () => ({} as any))).toBeNull();
    expect(preparePinnedStoredBatchRuntime(item(), () => ({ admittedChat: { contract:'wrong' } } as any))).toBeNull();
  });
  it('prepares chat and completions without importing server bootstrap', () => {
    const adapter = { contract:'openrouter-pinned-provider-chat-v1', execute: vi.fn() };
    expect(preparePinnedStoredBatchRuntime(item('chat'), () => ({ admittedChat:adapter } as any))).not.toBeNull();
    expect(preparePinnedStoredBatchRuntime(item('completions'), () => ({ admittedChat:adapter } as any))).not.toBeNull();
  });
  it('fails closed before dispatch if a global egress proxy appears after admission', () => {
    const previous = process.env.AIAG_EGRESS_PROXY_URL;
    const adapter = { contract:'openrouter-pinned-provider-chat-v1', execute: vi.fn() };
    try {
      process.env.AIAG_EGRESS_PROXY_URL = 'http://proxy-after-admission.invalid';
      expect(preparePinnedStoredBatchRuntime(item('chat'), () => ({ admittedChat:adapter } as any))).toBeNull();
      expect(adapter.execute).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.AIAG_EGRESS_PROXY_URL;
      else process.env.AIAG_EGRESS_PROXY_URL = previous;
    }
  });
});
