import { randomUUID } from 'node:crypto';
import { prepareStoredEmbeddingQuote, type FrozenEmbeddingCandidate } from './embedding-candidate-quote';
import { parseStoredEmbeddingsBody, validateStoredEmbeddingsIdentity, captureStoredEmbeddingsEvidence, STORED_EMBEDDINGS_FORMULA } from './stored-embeddings-attempt-contract';
import { normalizeAdmissionUuid, parseAdmissionJsonObject, type JsonObject } from './admission-result';
import type { AdmitGatewayChargeV2Args } from './quota-admission';
import type { ApiKeyPolicies, Mode } from '../routing/engine';
import type { ResolvedModel } from '../routing/resolver';
import type { AdmittedEmbeddingsMechanics, AdmittedEmbeddingsRequest, UpstreamAdapter } from '../upstreams/interface';
import { getUpstream } from '../upstreams/registry';

export type StoredEmbeddingsExecutionArgs = Readonly<{
  orgId:string; apiKeyId:string; clientRequestId:string|null; declaredSessionId:string|null;
  model:ResolvedModel; requestedMode:Mode; policy:Readonly<ApiKeyPolicies>; body:unknown;
  preDispatchDeadlineAt:string;
}>;

export type StoredEmbeddingsExecutionPreparation =
  | Readonly<{status:'bad_request';code:'INVALID_STORED_EMBEDDINGS_REQUEST'}>
  | Readonly<{status:'unavailable';code:'STORED_EMBEDDINGS_UNAVAILABLE'}>
  | StoredEmbeddingsExecutionReady;

export type StoredEmbeddingsExecutionReady = Readonly<{
  status:'ready';
  routeKind:'embeddings';
  billingRequestId:string;
  attemptId:string;
  admissionArgs:AdmitGatewayChargeV2Args;
  pricingSnapshot:JsonObject;
  adapterKey:string;
  upstreamId:string;
  upstreamModelId:string;
  modelUpstreamId:string;
  adapterContract:string;
  providerRequest:AdmittedEmbeddingsRequest;
  normalizedBody:Readonly<{modelSlug:string;input:readonly string[]}>;
  candidate:FrozenEmbeddingCandidate;
}>;

export type StoredEmbeddingsExecutionDependencies=Readonly<{
  getAdapter:(key:string)=>UpstreamAdapter;
  newUuid:()=>string;
}>;

const unavailable=Object.freeze({status:'unavailable',code:'STORED_EMBEDDINGS_UNAVAILABLE'} as const);

export function prepareStoredEmbeddingsExecution(
  args:StoredEmbeddingsExecutionArgs,
  partial:Partial<StoredEmbeddingsExecutionDependencies>={},
):StoredEmbeddingsExecutionPreparation{
  let body:ReturnType<typeof parseStoredEmbeddingsBody>, identity:ReturnType<typeof validateStoredEmbeddingsIdentity>;
  try{body=parseStoredEmbeddingsBody(args.body,args.model.slug); identity=validateStoredEmbeddingsIdentity(args);}catch{return Object.freeze({status:'bad_request',code:'INVALID_STORED_EMBEDDINGS_REQUEST'} as const);}
  const deps={getAdapter:getUpstream,newUuid:randomUUID,...partial};
  const mechanics=new Map<string,UpstreamAdapter|null>();
  const lookup=(key:string):UpstreamAdapter=>{
    if(!mechanics.has(key)){
      let facade:UpstreamAdapter|null=null;
      try{
        const captured=deps.getAdapter(key).admittedEmbeddings;
        if(captured?.contract&&typeof captured.execute==='function'){
          facade=Object.freeze({admittedEmbeddings:Object.freeze({contract:captured.contract,execute:captured.execute.bind(captured)}),chat:async()=>{throw new Error('Legacy chat is not admitted');}});
        }
      }catch{}
      mechanics.set(key,facade);
    }
    const adapter=mechanics.get(key);
    if(!adapter) throw new Error('Admitted embeddings mechanics unavailable');
    return adapter;
  };
  let quote:ReturnType<typeof prepareStoredEmbeddingQuote>;
  try{quote=prepareStoredEmbeddingQuote({model:args.model,requestedMode:args.requestedMode,policy:args.policy,inputCount:body.input.length,getAdapter:lookup});}
  catch{return unavailable;}
  if(quote.status!=='ready') return unavailable;
  const chosen=quote.candidates[0];
  if(!mechanics.get(chosen.adapterKey)?.admittedEmbeddings?.execute||chosen.maxCredits!==quote.authorizedMaxCredits) return unavailable;
  let billingRequestId:string,attemptId:string;
  try{
    billingRequestId=normalizeAdmissionUuid(deps.newUuid());
    attemptId=normalizeAdmissionUuid(deps.newUuid());
    if(billingRequestId===attemptId) return unavailable;
  }catch{return unavailable;}

  const actualChargePolicy=Object.freeze({formulaVersion:STORED_EMBEDDINGS_FORMULA,cachingDiscount:'1'});
  const quoteSnapshot=parseAdmissionJsonObject({version:1,tokenQuote:quote.quoteSnapshot,actualChargePolicy});
  const supplierQuoteSnapshot=parseAdmissionJsonObject({version:2,formulaVersion:'catalog-input-output-cents-per-1k-usd-micro-v2',tokenQuote:quote.quoteSnapshot});
  const admissionArgs:AdmitGatewayChargeV2Args=Object.freeze({
    orgId:identity.orgId,apiKeyId:identity.apiKeyId,
    clientRequestId:identity.clientRequestId,declaredSessionId:identity.declaredSessionId,
    supplierQuoteSnapshot,preDispatchDeadlineAt:identity.preDispatchDeadlineAt,billingRequestId,
    routeKind:'embeddings',billingMode:'stored',modelSlug:body.modelSlug,
    authorizedMaxCredits:quote.authorizedMaxCredits,quoteSnapshot,
  });
  const pricingSnapshot=parseAdmissionJsonObject({...quote.quoteSnapshot.candidates[0],actualChargePolicy});
  const providerRequest:AdmittedEmbeddingsRequest=Object.freeze({
    modelId:chosen.upstreamModelId,input:body.input,endpointPolicy:chosen.profile.endpointPolicy,
    ...(chosen.egressProxyUrl==null?{}:{egressProxyUrl:chosen.egressProxyUrl}),
  });
  return Object.freeze({
    status:'ready',routeKind:'embeddings',billingRequestId,attemptId,admissionArgs,pricingSnapshot,
    adapterKey:chosen.adapterKey,upstreamId:chosen.upstreamId,upstreamModelId:chosen.upstreamModelId,
    modelUpstreamId:chosen.billing.modelUpstreamId,adapterContract:chosen.profile.adapterContract,
    providerRequest,normalizedBody:Object.freeze({modelSlug:body.modelSlug,input:body.input}),candidate:chosen,
  });
}

export function captureStoredEmbeddingsExecutionMechanics(
  prepared:StoredEmbeddingsExecutionReady,
  getAdapter:(key:string)=>UpstreamAdapter=getUpstream,
):AdmittedEmbeddingsMechanics|null{
  try{
    const mechanics=getAdapter(prepared.adapterKey).admittedEmbeddings;
    if(!mechanics||mechanics.contract!==prepared.adapterContract||typeof mechanics.execute!=='function') return null;
    return Object.freeze({contract:mechanics.contract,execute:mechanics.execute.bind(mechanics)});
  }catch{return null;}
}

export function capturePinnedStoredEmbeddingsEvidence(
  output:Parameters<typeof captureStoredEmbeddingsEvidence>[0],
  prepared:StoredEmbeddingsExecutionReady,
){
  return captureStoredEmbeddingsEvidence(output,prepared.candidate,prepared.billingRequestId,prepared.attemptId);
}
