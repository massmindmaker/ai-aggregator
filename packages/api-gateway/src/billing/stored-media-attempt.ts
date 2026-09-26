import { randomUUID } from 'node:crypto';
import { admitGatewayChargeV2, recordGatewayChargeOutcomeV2 } from './quota-admission';
import { markGatewayChargeDispatched, settleAdmittedGatewayCharge } from './admission';
import { parseAdmissionJsonObject, type GatewayChargeAdmissionResult } from './admission-result';
import { claimMediaJob, attachMediaProviderTask, readMediaJob, releaseUnadmittedMediaClaim, type MediaJobRead } from './media-job-storage';
import type { StoredMediaHttpIdentity } from './stored-media-http-identity';
import type { MediaUnitQuote } from './media-unit-quote';
import type { MediaJob } from '../upstreams/interface';

export type StoredMediaAttemptArgs = Readonly<{
  identity: StoredMediaHttpIdentity; orgId:string; apiKeyId:string; clientRequestId:string|null;
  deadlineAt:string; modelSlug:string; modelUpstreamId:string; upstreamId:string; upstreamModelId:string;
  providerFamily:'image'|'video'|'suno'; quote:MediaUnitQuote; priceCentsPerUnit:string; markup:string;
  submit:()=>Promise<MediaJob>; enqueue:(jobId:string)=>Promise<void>;
}>;
export type StoredMediaAttemptDeps = Readonly<{
 newUuid:()=>string; claim:typeof claimMediaJob; attach:typeof attachMediaProviderTask; read:typeof readMediaJob; releaseClaim:typeof releaseUnadmittedMediaClaim;
 admit:typeof admitGatewayChargeV2; dispatch:typeof markGatewayChargeDispatched; outcome:typeof recordGatewayChargeOutcomeV2; settle:typeof settleAdmittedGatewayCharge;
}>;
export type StoredMediaAttemptResult =
 | Readonly<{kind:'queued';taskId:string;billingRequestId:string;jobId:string}>
 | Readonly<{kind:'replay';job:MediaJobRead}>
 | Readonly<{kind:'reconciliation_required';taskId:string;billingRequestId:string;stage:'admit'|'dispatch'|'provider'|'attach'|'enqueue'}>;

function providerTask(job:MediaJob):string {
 if(typeof job.job_id!=='string'||job.job_id.length<1||job.job_id.length>256) throw new Error('invalid provider task');
 return job.job_id;
}
export function createStoredMediaAttempt(args:StoredMediaAttemptArgs,partial:Partial<StoredMediaAttemptDeps>={}){
 const deps:StoredMediaAttemptDeps={newUuid:randomUUID,claim:claimMediaJob,attach:attachMediaProviderTask,read:readMediaJob,releaseClaim:releaseUnadmittedMediaClaim,admit:admitGatewayChargeV2,dispatch:markGatewayChargeDispatched,outcome:recordGatewayChargeOutcomeV2,settle:settleAdmittedGatewayCharge,...partial};
 const billingRequestId=deps.newUuid(),attemptId=deps.newUuid(),jobUuid=deps.newUuid();
 const taskId='task_'+jobUuid.replaceAll('-','');
 const mediaQuote=Object.freeze({version:1,formulaVersion:'media-unit-microcredits-v1',routeKind:args.identity.routeKind,modelSlug:args.modelSlug,modelUpstreamId:args.modelUpstreamId,upstreamId:args.upstreamId,upstreamModelId:args.upstreamModelId,providerFamily:args.providerFamily,units:args.quote.units,priceCentsPerUnit:args.priceCentsPerUnit,markup:args.markup,authorizedMaxCredits:args.quote.retailMaxMicrocredits.toString()});
 const quoteSnapshot=parseAdmissionJsonObject({version:1,mediaQuote});
 const supplierQuoteSnapshot=parseAdmissionJsonObject({version:2,formulaVersion:'media-supplier-unit-microcredits-v1',mediaQuote});
 const pricingSnapshot=parseAdmissionJsonObject({...mediaQuote,supplierMaxMicrocredits:args.quote.supplierMaxMicrocredits.toString(),supplierMaxUsdMicro:(args.quote.supplierMaxMicrocredits*10n).toString()});
 let run:Promise<StoredMediaAttemptResult>|undefined;
 return Object.freeze({taskId,billingRequestId,run(){return run??=(async()=>{
  const claimed=await deps.claim({identity:args.identity,orgId:args.orgId,apiKeyId:args.apiKeyId,billingRequestId,taskId,modelSlug:args.modelSlug,upstreamId:args.upstreamId,modelUpstreamId:args.modelUpstreamId,providerFamily:args.providerFamily,retailMaxMicrocredits:args.quote.retailMaxMicrocredits,supplierMaxMicrocredits:args.quote.supplierMaxMicrocredits,deadlineAt:args.deadlineAt,input:args.identity.body});
  const durableBillingRequestId=claimed.billingRequestId;
  if(!claimed.didClaim){const existing=await deps.read(args.orgId,claimed.taskId);if(!existing)throw new Error('media replay unavailable');if(existing.status==='claimed')return Object.freeze({kind:'reconciliation_required' as const,taskId:claimed.taskId,billingRequestId:durableBillingRequestId,stage:'admit' as const});return Object.freeze({kind:'replay' as const,job:existing});}
  let admission:GatewayChargeAdmissionResult;
  try{admission=await deps.admit({orgId:args.orgId,apiKeyId:args.apiKeyId,clientRequestId:args.clientRequestId,billingRequestId:durableBillingRequestId,routeKind:args.identity.routeKind,billingMode:'stored',modelSlug:args.modelSlug,authorizedMaxCredits:args.quote.retailMaxMicrocredits,quoteSnapshot,preDispatchDeadlineAt:args.deadlineAt,declaredSessionId:args.identity.declaredSessionId,supplierQuoteSnapshot});}
  catch(error){try{if(await deps.releaseClaim({orgId:args.orgId,jobId:claimed.id,billingRequestId:durableBillingRequestId}))throw error;}catch(releaseError){if(releaseError===error)throw error;}return Object.freeze({kind:'reconciliation_required' as const,taskId:claimed.taskId,billingRequestId:durableBillingRequestId,stage:'admit' as const});}
  try{const d=await deps.dispatch({admission,attemptId,upstreamId:args.upstreamId,pricingSnapshot});if(d.kind!=='dispatch_granted'||d.admission.state!=='dispatched')return Object.freeze({kind:'reconciliation_required' as const,taskId:claimed.taskId,billingRequestId:durableBillingRequestId,stage:'dispatch' as const});admission=d.admission;}
  catch{return Object.freeze({kind:'reconciliation_required' as const,taskId:claimed.taskId,billingRequestId:durableBillingRequestId,stage:'dispatch' as const});}
  let provider:MediaJob;try{provider=await args.submit();}catch{return Object.freeze({kind:'reconciliation_required' as const,taskId:claimed.taskId,billingRequestId:durableBillingRequestId,stage:'provider' as const});}
  try{await deps.attach({orgId:args.orgId,jobId:claimed.id,billingRequestId:durableBillingRequestId,providerTaskId:providerTask(provider)});}catch{return Object.freeze({kind:'reconciliation_required' as const,taskId:claimed.taskId,billingRequestId:durableBillingRequestId,stage:'attach' as const});}
  try{await args.enqueue(claimed.id);}catch{return Object.freeze({kind:'reconciliation_required' as const,taskId:claimed.taskId,billingRequestId:durableBillingRequestId,stage:'enqueue' as const});}
  return Object.freeze({kind:'queued' as const,taskId:claimed.taskId,billingRequestId:durableBillingRequestId,jobId:claimed.id});
 })();}});
}
