import { randomUUID } from 'node:crypto';
import { prepareStoredChatQuote, type FrozenChatCandidate } from './candidate-quote';
import { parseStoredChatBody, validateStoredChatIdentity, captureStoredChatEvidence, STORED_CHAT_FORMULA } from './stored-chat-attempt-contract';
import { normalizeAdmissionUuid, parseAdmissionJsonObject, type JsonObject } from './admission-result';
import type { AdmitGatewayChargeV2Args } from './quota-admission';
import type { ApiKeyPolicies, Mode } from '../routing/engine';
import type { ResolvedModel } from '../routing/resolver';
import type { AdmittedChatRequest, AdmittedChatMechanics, UpstreamAdapter } from '../upstreams/interface';
import { getUpstream } from '../upstreams/registry';

export type StoredChatExecutionArgs = Readonly<{
  orgId:string; apiKeyId:string; clientRequestId:string|null; declaredSessionId:string|null;
  model:ResolvedModel; requestedMode:Mode; policy:Readonly<ApiKeyPolicies>; body:unknown;
  defaultMaxOutputTokens:number; cachingDiscount:string; preDispatchDeadlineAt:string;
}>;

export type StoredChatExecutionPreparation =
  | Readonly<{status:'bad_request';code:'INVALID_STORED_CHAT_REQUEST'}>
  | Readonly<{status:'unavailable';code:'STORED_CHAT_UNAVAILABLE'}>
  | StoredChatExecutionReady;

export type StoredChatExecutionReady = Readonly<{
  status:'ready';
  routeKind:'chat'|'completions';
  billingRequestId:string;
  attemptId:string;
  admissionArgs:AdmitGatewayChargeV2Args;
  pricingSnapshot:JsonObject;
  adapterKey:string;
  upstreamId:string;
  upstreamModelId:string;
  modelUpstreamId:string;
  adapterContract:string;
  providerRequest:AdmittedChatRequest;
  normalizedBody:Readonly<{modelSlug:string;messages:readonly Readonly<{role:'system'|'user'|'assistant';content:string}>[];maxTokens?:number}>;
  candidate:FrozenChatCandidate;
  cachingDiscount:string;
}>;

export type StoredChatExecutionDependencies = Readonly<{
  admissionRouteKind?:'chat'|'completions';
  getAdapter:(key:string)=>UpstreamAdapter;
  newUuid:()=>string;
}>;

const unavailable=Object.freeze({status:'unavailable',code:'STORED_CHAT_UNAVAILABLE'} as const);

export function prepareStoredChatExecution(
  args:StoredChatExecutionArgs,
  partial:Partial<StoredChatExecutionDependencies>={},
):StoredChatExecutionPreparation{
  let body:ReturnType<typeof parseStoredChatBody>, identity:ReturnType<typeof validateStoredChatIdentity>;
  try{body=parseStoredChatBody(args.body,args.model.slug); identity=validateStoredChatIdentity(args);}catch{return Object.freeze({status:'bad_request',code:'INVALID_STORED_CHAT_REQUEST'} as const);}
  const deps={admissionRouteKind:'chat' as const,getAdapter:getUpstream,newUuid:randomUUID,...partial};
  const routeKind=deps.admissionRouteKind;
  if(routeKind!=='chat'&&routeKind!=='completions') return unavailable;

  const mechanics=new Map<string,UpstreamAdapter|null>();
  const lookup=(key:string):UpstreamAdapter=>{
    if(!mechanics.has(key)){
      let facade:UpstreamAdapter|null=null;
      try{
        const captured=deps.getAdapter(key).admittedChat;
        if(captured?.contract&&typeof captured.execute==='function'){
          facade=Object.freeze({admittedChat:Object.freeze({contract:captured.contract,execute:captured.execute.bind(captured)}),chat:async()=>{throw new Error('Legacy chat is not admitted');}});
        }
      }catch{}
      mechanics.set(key,facade);
    }
    const adapter=mechanics.get(key);
    if(!adapter) throw new Error('Admitted mechanics unavailable');
    return adapter;
  };

  let quote:ReturnType<typeof prepareStoredChatQuote>;
  try{
    quote=prepareStoredChatQuote({
      model:args.model,requestedMode:args.requestedMode,policy:args.policy,
      ...(body.maxTokens===undefined?{}:{clientMaxTokens:body.maxTokens}),
      defaultMaxOutputTokens:args.defaultMaxOutputTokens,getAdapter:lookup,
    });
  }catch{return unavailable;}
  if(quote.status!=='ready') return quote.status==='bad_request'
    ? Object.freeze({status:'bad_request',code:'INVALID_STORED_CHAT_REQUEST'} as const)
    : unavailable;
  const chosen=quote.candidates[0]!;
  if(!mechanics.get(chosen.adapterKey)?.admittedChat?.execute||chosen.maxCredits>quote.authorizedMaxCredits) return unavailable;

  let billingRequestId:string,attemptId:string;
  try{
    billingRequestId=normalizeAdmissionUuid(deps.newUuid());
    attemptId=normalizeAdmissionUuid(deps.newUuid());
    if(billingRequestId===attemptId) return unavailable;
  }catch{return unavailable;}

  const actualChargePolicy=Object.freeze({formulaVersion:STORED_CHAT_FORMULA,cachingDiscount:identity.cachingDiscount});
  const quoteSnapshot=parseAdmissionJsonObject({version:1,tokenQuote:quote.quoteSnapshot,actualChargePolicy});
  const supplierQuoteSnapshot=parseAdmissionJsonObject({version:2,formulaVersion:'catalog-input-output-cents-per-1k-usd-micro-v2',tokenQuote:quote.quoteSnapshot});
  const admissionArgs:AdmitGatewayChargeV2Args=Object.freeze({
    orgId:identity.orgId,apiKeyId:identity.apiKeyId,
    clientRequestId:identity.clientRequestId,declaredSessionId:identity.declaredSessionId,
    supplierQuoteSnapshot,preDispatchDeadlineAt:identity.preDispatchDeadlineAt,billingRequestId,
    routeKind,billingMode:'stored',modelSlug:body.modelSlug,authorizedMaxCredits:quote.authorizedMaxCredits,quoteSnapshot,
  });
  const pricingSnapshot=parseAdmissionJsonObject({...quote.quoteSnapshot.candidates[0],actualChargePolicy});
  const providerRequest:AdmittedChatRequest=Object.freeze({
    modelId:chosen.upstreamModelId,messages:body.messages,maxTokens:chosen.maxOutputTokens,
    endpointPolicy:chosen.profile.endpointPolicy,
    ...(chosen.egressProxyUrl==null?{}:{egressProxyUrl:chosen.egressProxyUrl}),
  });
  return Object.freeze({
    status:'ready',routeKind,billingRequestId,attemptId,admissionArgs,pricingSnapshot,
    adapterKey:chosen.adapterKey,upstreamId:chosen.upstreamId,upstreamModelId:chosen.upstreamModelId,
    modelUpstreamId:chosen.billing.modelUpstreamId,adapterContract:chosen.profile.adapterContract,
    providerRequest,normalizedBody:Object.freeze({modelSlug:body.modelSlug,messages:body.messages,...(body.maxTokens===undefined?{}:{maxTokens:body.maxTokens})}),
    candidate:chosen,cachingDiscount:identity.cachingDiscount,
  });
}

export function captureStoredChatExecutionMechanics(
  prepared:StoredChatExecutionReady,
  getAdapter:(key:string)=>UpstreamAdapter=getUpstream,
):AdmittedChatMechanics|null{
  try{
    const mechanics=getAdapter(prepared.adapterKey).admittedChat;
    if(!mechanics||mechanics.contract!==prepared.adapterContract||typeof mechanics.execute!=='function') return null;
    return Object.freeze({contract:mechanics.contract,execute:mechanics.execute.bind(mechanics)});
  }catch{return null;}
}

export function capturePinnedStoredChatEvidence(
  output:Parameters<typeof captureStoredChatEvidence>[0],
  prepared:StoredChatExecutionReady,
){
  return captureStoredChatEvidence(output,prepared.candidate,prepared.cachingDiscount,prepared.billingRequestId,prepared.attemptId);
}
