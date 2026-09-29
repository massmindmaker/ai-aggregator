import { randomUUID } from 'node:crypto';
import { admitGatewayChargeV2,recordGatewayChargeOutcomeV2 } from './quota-admission';
import { markGatewayChargeDispatched,readGatewayChargeAdmission,settleAdmittedGatewayCharge } from './admission';
import { parseAdmissionJsonObject,type GatewayChargeAdmissionResult } from './admission-result';
import {
  claimMediaJob,readMediaJob,releaseUnadmittedMediaClaim,recordSyncTranscriptionResult,
  type MediaJobClaim,type MediaJobRead,
} from './media-job-storage';
import type { StoredTranscriptionHttpIdentity } from './stored-transcription-http-identity';

export type StoredTranscriptionQuote=Readonly<{
  billableMs:number;supplierRateUsdMicroPerHour:number;
  supplierMaxUsdMicro:bigint;supplierMaxMicrocredits:bigint;retailMaxMicrocredits:bigint;
  formulaVersion:'groq-whisper-duration-v1';
  supplierFormulaVersion:'groq-whisper-duration-usd-micro-v1';
}>;
type ProviderResult=Readonly<{
  text:string;
  providerDurationMs:number;
  providerResponseId:string|null;
}>;
export type StoredTranscriptionAttemptArgs=Readonly<{
  identity:StoredTranscriptionHttpIdentity;audioBytes:Uint8Array;orgId:string;apiKeyId:string;clientRequestId:string|null;
  deadlineAt:string;modelSlug:'whisper-large-v3';modelUpstreamId:string;upstreamId:'groq';upstreamModelId:'whisper-large-v3';
  quote:StoredTranscriptionQuote;markup:string;execute:()=>Promise<ProviderResult>;
}>;
type ReconciliationStage='admit'|'dispatch'|'provider'|'outcome'|'settle';
export type StoredTranscriptionAttemptResult=
  | Readonly<{kind:'completed';taskId:string;billingRequestId:string;text:string}>
  | Readonly<{kind:'reconciliation_required';taskId:string;billingRequestId:string;stage:ReconciliationStage}>;
export type StoredTranscriptionAttemptDeps=Readonly<{
  newUuid:()=>string;claim:typeof claimMediaJob;read:typeof readMediaJob;releaseClaim:typeof releaseUnadmittedMediaClaim;
  admit:typeof admitGatewayChargeV2;dispatch:typeof markGatewayChargeDispatched;readAdmission:typeof readGatewayChargeAdmission;
  terminal:typeof recordSyncTranscriptionResult;outcome:typeof recordGatewayChargeOutcomeV2;settle:typeof settleAdmittedGatewayCharge;
}>;

function transcript(job:MediaJobRead):string|null{
  if(job.routeKind!=='audio_transcription'||job.providerFamily!=='groq_stt'||job.status!=='completed'||!job.output||typeof job.output!=='object')return null;
  const value=job.output as Record<string,unknown>;
  if(Object.keys(value).length!==1||typeof value.text!=='string'||Buffer.byteLength(value.text,'utf8')>1_000_000)return null;
  return value.text;
}
function providerEvidenceMatches(identity:StoredTranscriptionHttpIdentity,value:ProviderResult):boolean{
  return Number.isSafeInteger(value.providerDurationMs)&&value.providerDurationMs>0&&
    Math.abs(value.providerDurationMs-identity.durationMs)<=1000&&
    (value.providerResponseId===null||
      (typeof value.providerResponseId==='string'&&value.providerResponseId.length>=1&&value.providerResponseId.length<=256&&/^[A-Za-z0-9._:-]+$/.test(value.providerResponseId)));
}

export function createStoredTranscriptionAttempt(args:StoredTranscriptionAttemptArgs,partial:Partial<StoredTranscriptionAttemptDeps>={}){
  if(
    args.quote.billableMs!==args.identity.billableMs||
    args.quote.supplierRateUsdMicroPerHour!==111000||
    args.quote.formulaVersion!=='groq-whisper-duration-v1'||
    args.quote.supplierFormulaVersion!=='groq-whisper-duration-usd-micro-v1'
  ) throw new Error('Invalid stored transcription quote binding');

  const deps:StoredTranscriptionAttemptDeps={
    newUuid:randomUUID,claim:claimMediaJob,read:readMediaJob,releaseClaim:releaseUnadmittedMediaClaim,
    admit:admitGatewayChargeV2,dispatch:markGatewayChargeDispatched,readAdmission:readGatewayChargeAdmission,
    terminal:recordSyncTranscriptionResult,outcome:recordGatewayChargeOutcomeV2,settle:settleAdmittedGatewayCharge,...partial,
  };
  const billingRequestId=deps.newUuid(),attemptId=deps.newUuid(),jobUuid=deps.newUuid(),taskId='task_'+jobUuid.replaceAll('-','');
  const transcriptionQuote=Object.freeze({
    version:1,formulaVersion:'groq-whisper-duration-v1',routeKind:'audio_transcription',
    modelSlug:args.modelSlug,modelUpstreamId:args.modelUpstreamId,upstreamId:args.upstreamId,
    upstreamModelId:args.upstreamModelId,providerFamily:'groq_stt',
    billableMs:args.quote.billableMs,rateUsdMicroPerHour:args.quote.supplierRateUsdMicroPerHour,
    markup:args.markup,supplierMaxMicrocredits:args.quote.supplierMaxMicrocredits.toString(),
    supplierMaxUsdMicro:args.quote.supplierMaxUsdMicro.toString(),
    authorizedMaxCredits:args.quote.retailMaxMicrocredits.toString(),
  });
  const quoteSnapshot=parseAdmissionJsonObject({version:1,transcriptionQuote});
  const supplierQuoteSnapshot=parseAdmissionJsonObject({version:2,formulaVersion:'groq-whisper-duration-usd-micro-v1',transcriptionQuote});
  const pricingSnapshot=parseAdmissionJsonObject(transcriptionQuote);
  const usage=(anchor:GatewayChargeAdmissionResult)=>parseAdmissionJsonObject({
    version:1,formulaVersion:'groq-whisper-duration-v1',billingRequestId:anchor.billingRequestId,
    attemptId:anchor.attemptId,upstreamId:anchor.upstreamId,terminalStatus:'completed',verified:true,
  });
  const reconciliation=(job:Pick<MediaJobRead,'taskId'|'billingRequestId'>|MediaJobClaim,stage:ReconciliationStage)=>
    Object.freeze({kind:'reconciliation_required' as const,taskId:job.taskId,billingRequestId:job.billingRequestId,stage});

  async function finalizePersisted(job:MediaJobRead):Promise<StoredTranscriptionAttemptResult>{
    const text=transcript(job);if(text===null)return reconciliation(job,'outcome');
    let anchor:GatewayChargeAdmissionResult;
    try{anchor=await deps.readAdmission(job.billingRequestId);}catch{return reconciliation(job,'outcome');}
    if(job.settledAt!==null){
      if(anchor.state!=='settled')return reconciliation(job,anchor.state==='dispatched'?'outcome':'settle');
      return Object.freeze({kind:'completed' as const,taskId:job.taskId,billingRequestId:job.billingRequestId,text});
    }
    if(anchor.state==='dispatched'){
      try{anchor=await deps.outcome({admission:anchor,actualCostCredits:args.quote.retailMaxMicrocredits,usageSnapshot:usage(anchor),outcomeKind:'success'});}
      catch{return reconciliation(job,'outcome');}
    }
    if(anchor.state==='outcome_recorded'){
      try{anchor=await deps.settle({admission:anchor});}catch{return reconciliation(job,'settle');}
    }
    if(anchor.state!=='settled')return reconciliation(job,anchor.state==='dispatched'?'outcome':'settle');
    try{await deps.terminal({orgId:args.orgId,jobId:job.id,billingRequestId:job.billingRequestId,output:{text}});}
    catch{return reconciliation(job,'settle');}
    return Object.freeze({kind:'completed' as const,taskId:job.taskId,billingRequestId:job.billingRequestId,text});
  }

  async function executeAfterFreshDispatch(job:MediaJobRead|MediaJobClaim,admission:GatewayChargeAdmissionResult):Promise<StoredTranscriptionAttemptResult>{
    let dispatched:Awaited<ReturnType<StoredTranscriptionAttemptDeps['dispatch']>>;
    try{dispatched=await deps.dispatch({admission,attemptId,upstreamId:args.upstreamId,pricingSnapshot});}
    catch{return reconciliation(job,'dispatch');}
    if(dispatched.kind!=='dispatch_granted'||dispatched.admission.state!=='dispatched')return reconciliation(job,'dispatch');

    let provider:ProviderResult;
    try{provider=await args.execute();}catch{return reconciliation(job,'provider');}
    if(!providerEvidenceMatches(args.identity,provider))return reconciliation(job,'provider');

    try{await deps.terminal({orgId:args.orgId,jobId:job.id,billingRequestId:job.billingRequestId,output:{text:provider.text}});}
    catch{return reconciliation(job,'outcome');}
    const persisted=await deps.read(args.orgId,job.taskId);
    if(!persisted||persisted.status!=='completed')return reconciliation(job,'outcome');
    return finalizePersisted(persisted);
  }

  async function admitFor(job:MediaJobRead|MediaJobClaim,preDispatchDeadlineAt=args.deadlineAt):Promise<GatewayChargeAdmissionResult|StoredTranscriptionAttemptResult>{
    try{
      return await deps.admit({
        orgId:args.orgId,apiKeyId:args.apiKeyId,clientRequestId:args.clientRequestId,billingRequestId:job.billingRequestId,
        routeKind:'audio_transcription',billingMode:'stored',modelSlug:args.modelSlug,authorizedMaxCredits:args.quote.retailMaxMicrocredits,
        quoteSnapshot,preDispatchDeadlineAt,declaredSessionId:args.identity.declaredSessionId,supplierQuoteSnapshot,
      });
    }catch(error){
      try{if(await deps.releaseClaim({orgId:args.orgId,jobId:job.id,billingRequestId:job.billingRequestId}))throw error;}
      catch(releaseError){if(releaseError===error)throw error;}
      return reconciliation(job,'admit');
    }
  }

  let run:Promise<StoredTranscriptionAttemptResult>|undefined;
  return Object.freeze({taskId,billingRequestId,run(){return run??=(async()=>{
    const claimed=await deps.claim({
      identity:args.identity,orgId:args.orgId,apiKeyId:args.apiKeyId,billingRequestId,taskId,
      modelSlug:args.modelSlug,upstreamId:args.upstreamId,modelUpstreamId:args.modelUpstreamId,providerFamily:'groq_stt',
      retailMaxMicrocredits:args.quote.retailMaxMicrocredits,supplierMaxMicrocredits:args.quote.supplierMaxMicrocredits,
      deadlineAt:args.deadlineAt,input:Object.freeze({
        model:args.identity.model,language:args.identity.language,format:'pcm_wav',parserContract:args.identity.parserContract,fileSha256:args.identity.audioSha256,
        byteLength:args.identity.audioBytes,sampleRate:args.identity.sampleRate,channels:args.identity.channels,
        bitsPerSample:args.identity.bitsPerSample,frames:args.identity.frames,durationMs:args.identity.durationMs,billableMs:args.identity.billableMs,
      }),
    });

    if(!claimed.didClaim){
      const existing=await deps.read(args.orgId,claimed.taskId);
      if(!existing)return reconciliation(claimed,'provider');
      if(existing.status==='completed')return finalizePersisted(existing);
      if(existing.status!=='claimed')return reconciliation(existing,'provider');
      let admission:GatewayChargeAdmissionResult;
      try{admission=await deps.readAdmission(existing.billingRequestId);}
      catch{
        const recovered=await admitFor(existing,existing.deadlineAt);
        if('kind' in recovered)return recovered;
        admission=recovered;
      }
      if(admission.state==='held')return executeAfterFreshDispatch(existing,admission);
      return reconciliation(existing,admission.state==='dispatched'?'provider':'outcome');
    }

    const admission=await admitFor(claimed);
    if('kind' in admission)return admission;
    if(admission.state!=='held')return reconciliation(claimed,admission.state==='dispatched'?'provider':'outcome');
    return executeAfterFreshDispatch(claimed,admission);
  })();}});
}
