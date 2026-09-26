import { Hono } from 'hono';
import { errors } from '../../lib/errors';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';
import { resolveModelWithOverride } from '../../routing/resolver';
import { pickUpstream, type ApiKeyPolicies, type Mode } from '../../routing/engine';
import { getUpstream } from '../../upstreams/registry';
import { captureStoredMediaHttpIdentity, type StoredMediaRouteKind } from '../../billing/stored-media-http-identity';
import { quoteMediaUnits } from '../../billing/media-unit-quote';
import { createStoredMediaAttempt } from '../../billing/stored-media-attempt';
import { readMediaJob } from '../../billing/media-job-storage';
import { enqueueOwnedMediaPoll } from '../../lib/media-queue';

export const storedMedia=new Hono();
const deadline=()=>new Date(Date.now()+30*60_000).toISOString();
function family(route:StoredMediaRouteKind):'image'|'video'|'suno'{return route==='image'?'image':route==='video'?'video':'suno';}
function publicJob(job:Awaited<ReturnType<typeof readMediaJob>>){
 if(!job)throw errors.notFound('Media job not found');
 return {task_id:job.taskId,status:job.status==='claimed'?'queued':job.status,...(job.status==='completed'?{output:job.output}:{}),...(job.status==='failed'?{error:{code:'MEDIA_JOB_FAILED',message:'Media job failed'}}:{})};
}
async function submit(c:any,routeKind:StoredMediaRouteKind){
 const key=c.get('apiKey' as never) as AuthenticatedApiKey; const orgId=key.org_id;
 const body=await c.req.json();
 const identity=(()=>{try{return captureStoredMediaHttpIdentity({routeKind,body,idempotencyKey:c.req.header('idempotency-key'),declaredSessionId:c.req.header('x-aiag-session-id') ?? null,byokKeyPresent:c.req.raw.headers.has('x-upstream-key')});}catch{throw errors.badRequest('Invalid media request');}})();
 const model=await resolveModelWithOverride(String(identity.body.model));
 const expectedType=routeKind==='audio_speech'?'audio':routeKind;
 if(model.type!==expectedType)throw errors.badRequest('Invalid media request');
 const policies=(key.policies??{}) as ApiKeyPolicies; const mode=(identity.requestedMode??policies.default_mode??'auto') as Mode;
 const candidate=pickUpstream(model.candidates,mode,policies,expectedType);
 if(candidate.provider!=='kie'||candidate.egress_proxy||process.env.AIAG_EGRESS_PROXY_URL)throw errors.unavailable('Media capability unavailable');
 const exact=candidate.billing?.pricePerImageCents; const markup=candidate.billing?.prices.markup;
 if(!candidate.billing||!exact||!markup)throw errors.unavailable('Media pricing unavailable');
 const units=routeKind==='image'?Number(identity.body.n??1):1; const quote=quoteMediaUnits({priceCentsPerUnit:exact,markup},units);
 const adapter=getUpstream(candidate.provider); let doSubmit:()=>Promise<any>;
 if(routeKind==='image'){if(!adapter.imageGeneration)throw errors.unavailable('Media capability unavailable');doSubmit=()=>adapter.imageGeneration!({modelId:candidate.upstream_model_id,prompt:String(identity.body.prompt),n:units,size:identity.body.size as string|undefined,negative_prompt:identity.body.negative_prompt as string|undefined,reference_image_url:identity.body.reference_image_url as string|undefined,egressProxyUrl:candidate.egress_proxy??undefined});}
 else if(routeKind==='video'){if(!adapter.videoGeneration)throw errors.unavailable('Media capability unavailable');doSubmit=()=>adapter.videoGeneration!({modelId:candidate.upstream_model_id,prompt:String(identity.body.prompt),duration_s:identity.body.duration_s as number|undefined,aspect_ratio:identity.body.aspect_ratio as string|undefined,image_url:identity.body.image_url as string|undefined,egressProxyUrl:candidate.egress_proxy??undefined});}
 else {if(!adapter.audioSpeech)throw errors.unavailable('Media capability unavailable');doSubmit=()=>adapter.audioSpeech!({modelId:candidate.upstream_model_id,input:String(identity.body.input),voice:identity.body.voice as string|undefined,format:identity.body.format as string|undefined,egressProxyUrl:candidate.egress_proxy??undefined});}
 const attempt=createStoredMediaAttempt({identity,orgId,apiKeyId:key.id,clientRequestId:c.get('requestId' as never) as string|null,deadlineAt:deadline(),modelSlug:model.slug,modelUpstreamId:candidate.billing.modelUpstreamId,upstreamId:candidate.upstream_id,upstreamModelId:candidate.upstream_model_id,providerFamily:family(routeKind),quote,priceCentsPerUnit:exact,markup,submit:doSubmit,enqueue:enqueueOwnedMediaPoll});
 const result=await attempt.run();
 if(result.kind==='replay')return c.json(publicJob(result.job),result.job.status==='completed'?200:202);
 if(result.kind==='queued')return c.json({task_id:result.taskId,status:'queued'},202);
 return c.json({error:{code:'MEDIA_RECONCILIATION_REQUIRED',message:'Media request state unavailable'}},503);
}
storedMedia.post('/images/generations',(c)=>submit(c,'image'));
storedMedia.post('/video/generations',(c)=>submit(c,'video'));
storedMedia.post('/audio/speech',(c)=>submit(c,'audio_speech'));
storedMedia.get('/media/jobs/:taskId',async(c)=>{const key=c.get('apiKey' as never) as AuthenticatedApiKey;return c.json(publicJob(await readMediaJob(key.org_id,c.req.param('taskId'))));});
