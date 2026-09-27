import { randomUUID } from 'node:crypto';
import { config } from '../config';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';
import type { ResolvedModel } from '../routing/resolver';
import { resolveStoredChatFreshModel } from '../routing/stored-chat-fresh-resolver';
import { resolveStoredEmbeddingsFreshModel } from '../routing/stored-embeddings-fresh-resolver';
import type { UpstreamAdapter } from '../upstreams/interface';
import { getUpstream } from '../upstreams/registry';
import type { StoredChatHttpAttemptBody } from './stored-chat-http-identity';
import type { StoredEmbeddingsHttpAttemptBody } from './stored-embeddings-http-identity';
import {
  evaluateStoredChatFreshPolicy,
} from './stored-chat-fresh-policy';
import {
  evaluateStoredEmbeddingsFreshPolicy,
} from './stored-embeddings-fresh-policy';
import type { StoredBatchHttpIdentity, StoredBatchItemIdentity } from './stored-batch-http-identity';
import {
  prepareStoredChatExecution,
  type StoredChatExecutionPreparation,
  type StoredChatExecutionReady,
} from './stored-chat-execution-preparation';
import {
  prepareStoredEmbeddingsExecution,
  type StoredEmbeddingsExecutionPreparation,
  type StoredEmbeddingsExecutionReady,
} from './stored-embeddings-execution-preparation';

export type StoredBatchPreparedExecution =
  | StoredChatExecutionPreparation
  | StoredEmbeddingsExecutionPreparation;

export type StoredBatchPreparedItem = Readonly<{
  index:number;
  customId:string;
  routeKind:'chat'|'embeddings'|'completions';
  requestFingerprint:string;
  requestBody:StoredBatchItemIdentity['attemptBody'];
  execution:StoredBatchPreparedExecution;
}>;

export class StoredBatchItemPreparationError extends Error {
  constructor(readonly code:'STORED_BATCH_ITEM_UNAVAILABLE'|'STORED_BATCH_ITEM_INVALID'){
    super(code);
    this.name='StoredBatchItemPreparationError';
  }
}

type ChatPolicyIdentity=Readonly<{requestedMode:StoredBatchItemIdentity['requestedMode'];attemptBody:StoredChatHttpAttemptBody}>;
type EmbeddingsPolicyIdentity=Readonly<{requestedMode:StoredBatchItemIdentity['requestedMode'];attemptBody:StoredEmbeddingsHttpAttemptBody}>;

export type StoredBatchItemPreparationDependencies=Readonly<{
  resolveChatModel:(slug:string)=>Promise<ResolvedModel>;
  resolveEmbeddingsModel:(slug:string)=>Promise<ResolvedModel>;
  evaluateChatPolicy:(args:Readonly<{key:AuthenticatedApiKey;identity:ChatPolicyIdentity;model:ResolvedModel}>)=>Readonly<{model:ResolvedModel;policy:Readonly<Record<string,unknown>>;requestedMode:any}>;
  evaluateEmbeddingsPolicy:(args:Readonly<{key:AuthenticatedApiKey;identity:EmbeddingsPolicyIdentity;model:ResolvedModel}>)=>Readonly<{model:ResolvedModel;policy:Readonly<Record<string,unknown>>;requestedMode:any}>;
  getAdapter:(key:string)=>UpstreamAdapter;
  newUuid:()=>string;
  cachingDiscount:string;
  defaultMaxOutputTokens:number;
  globalEgressProxyUrl:string|undefined;
}>;

function assertNoProxy(prepared:StoredChatExecutionReady|StoredEmbeddingsExecutionReady,globalProxy:string|undefined):void{
  const candidate=prepared.candidate;
  if(candidate.egressProxyUrl||globalProxy?.trim()) throw new StoredBatchItemPreparationError('STORED_BATCH_ITEM_UNAVAILABLE');
}

export async function prepareStoredBatchItems(
  args:Readonly<{identity:StoredBatchHttpIdentity;key:AuthenticatedApiKey;requestId:string;deadlineAt:string}>,
  partial:Partial<StoredBatchItemPreparationDependencies>={},
):Promise<readonly StoredBatchPreparedItem[]>{
  const deps:StoredBatchItemPreparationDependencies={
    resolveChatModel:resolveStoredChatFreshModel,
    resolveEmbeddingsModel:resolveStoredEmbeddingsFreshModel,
    evaluateChatPolicy:evaluateStoredChatFreshPolicy as StoredBatchItemPreparationDependencies['evaluateChatPolicy'],
    evaluateEmbeddingsPolicy:evaluateStoredEmbeddingsFreshPolicy as StoredBatchItemPreparationDependencies['evaluateEmbeddingsPolicy'],
    getAdapter:getUpstream,
    newUuid:randomUUID,
    cachingDiscount:config.STORED_CHAT_CACHING_DISCOUNT_EXACT,
    defaultMaxOutputTokens:config.GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS,
    globalEgressProxyUrl:process.env.AIAG_EGRESS_PROXY_URL,
    ...partial,
  };
  const prepared:StoredBatchPreparedItem[]=[];
  for(const item of args.identity.items){
    try{
      if(item.routeKind==='embeddings'){
        const body=item.attemptBody as StoredEmbeddingsHttpAttemptBody;
        const model=await deps.resolveEmbeddingsModel(body.model);
        const policy=deps.evaluateEmbeddingsPolicy({
          key:args.key,
          identity:{requestedMode:item.requestedMode,attemptBody:body},
          model,
        });
        const execution=prepareStoredEmbeddingsExecution({
          orgId:args.key.org_id,apiKeyId:args.key.id,clientRequestId:args.requestId,
          declaredSessionId:args.identity.declaredSessionId,
          model:policy.model,requestedMode:policy.requestedMode,policy:policy.policy as any,
          body,preDispatchDeadlineAt:args.deadlineAt,
        },{getAdapter:deps.getAdapter,newUuid:deps.newUuid});
        if(execution.status!=='ready') throw new StoredBatchItemPreparationError(
          execution.status==='bad_request'?'STORED_BATCH_ITEM_INVALID':'STORED_BATCH_ITEM_UNAVAILABLE');
        assertNoProxy(execution,deps.globalEgressProxyUrl);
        prepared.push(Object.freeze({
          index:item.index,customId:item.customId,routeKind:item.routeKind,
          requestFingerprint:item.requestFingerprint,requestBody:item.attemptBody,execution,
        }));
        continue;
      }
      const body=item.attemptBody as StoredChatHttpAttemptBody;
      const model=await deps.resolveChatModel(body.model);
      const policy=deps.evaluateChatPolicy({
        key:args.key,
        identity:{requestedMode:item.requestedMode,attemptBody:body},
        model,
      });
      const execution=prepareStoredChatExecution({
        orgId:args.key.org_id,apiKeyId:args.key.id,clientRequestId:args.requestId,
        declaredSessionId:args.identity.declaredSessionId,
        model:policy.model,requestedMode:policy.requestedMode,policy:policy.policy as any,
        body,defaultMaxOutputTokens:deps.defaultMaxOutputTokens,cachingDiscount:deps.cachingDiscount,
        preDispatchDeadlineAt:args.deadlineAt,
      },{
        admissionRouteKind:item.routeKind==='completions'?'completions':'chat',
        getAdapter:deps.getAdapter,newUuid:deps.newUuid,
      });
      if(execution.status!=='ready') throw new StoredBatchItemPreparationError(
        execution.status==='bad_request'?'STORED_BATCH_ITEM_INVALID':'STORED_BATCH_ITEM_UNAVAILABLE');
      assertNoProxy(execution,deps.globalEgressProxyUrl);
      prepared.push(Object.freeze({
        index:item.index,customId:item.customId,routeKind:item.routeKind,
        requestFingerprint:item.requestFingerprint,requestBody:item.attemptBody,execution,
      }));
    }catch(error){
      if(error instanceof StoredBatchItemPreparationError) throw error;
      throw new StoredBatchItemPreparationError('STORED_BATCH_ITEM_UNAVAILABLE');
    }
  }
  return Object.freeze(prepared);
}
