import { Hono } from 'hono';
import { errors } from '../../lib/errors';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';
import { resolveModelWithOverride } from '../../routing/resolver';
import { pickUpstream, type ApiKeyPolicies, type Mode, type UpstreamCandidate } from '../../routing/engine';
import { getUpstream } from '../../upstreams/registry';
import { captureStoredMediaHttpIdentity, type StoredMediaRouteKind } from '../../billing/stored-media-http-identity';
import { quoteMediaUnits } from '../../billing/media-unit-quote';
import { createStoredMediaAttempt } from '../../billing/stored-media-attempt';
import { readMediaJob } from '../../billing/media-job-storage';
import { enqueueOwnedMediaPoll } from '../../lib/media-queue';
import type { ReviewedMediaProfile } from '../../billing/reviewed-media-profiles';

export const storedMedia=new Hono();
const deadline=()=>new Date(Date.now()+30*60_000).toISOString();
function family(route:StoredMediaRouteKind):'image'|'video'|'suno'{return route==='image'?'image':route==='video'?'video':'suno';}
function profileFor(modelSlug:string,modelType:string,routeKind:StoredMediaRouteKind,c:UpstreamCandidate):ReviewedMediaProfile|null{
  const p=c.reviewedMediaProfile;
  if(!p||routeKind==='audio_speech'||p.routeKind!==routeKind||p.modelSlug!==modelSlug||p.modelType!==modelType||
    p.upstreamId!==c.upstream_id||p.upstreamModelId!==c.upstream_model_id||p.adapterKey!==c.id)return null;
  return p;
}
function publicJob(job:Awaited<ReturnType<typeof readMediaJob>>){
  if(!job)throw errors.notFound('Media job not found');
  return {task_id:job.taskId,status:job.status==='claimed'?'queued':job.status,
    ...(job.status==='completed'?{output:job.output}:{}),
    ...(job.status==='failed'?{error:{code:'MEDIA_JOB_FAILED',message:'Media job failed'}}:{})};
}
async function submit(c:any,routeKind:StoredMediaRouteKind){
  const key=c.get('apiKey' as never) as AuthenticatedApiKey; const orgId=key.org_id;
  const body=await (async()=>{try{return await c.req.json();}catch{throw errors.badRequest('Invalid media request');}})();
  const identity=(()=>{try{return captureStoredMediaHttpIdentity({
    routeKind,body,idempotencyKey:c.req.header('idempotency-key'),
    declaredSessionId:c.req.header('x-aiag-session-id')??null,
    byokKeyPresent:c.req.raw.headers.has('x-upstream-key'),
  });}catch{throw errors.badRequest('Invalid media request');}})();
  const model=await resolveModelWithOverride(String(identity.body.model));
  const expectedType=routeKind==='audio_speech'?'audio':routeKind;
  if(model.type!==expectedType)throw errors.badRequest('Invalid media request');
  if(routeKind==='audio_speech')throw errors.unavailable('Audio speech capability unavailable');

  const reviewed=model.candidates.filter(candidate=>profileFor(model.slug,model.type,routeKind,candidate)!==null);
  if(reviewed.length===0)throw errors.unavailable('Media capability unavailable');
  const policies=(key.policies??{}) as ApiKeyPolicies;
  const mode=(identity.requestedMode??policies.default_mode??'auto') as Mode;
  const candidate=pickUpstream(reviewed,mode,policies,expectedType);
  const profile=profileFor(model.slug,model.type,routeKind,candidate);
  if(!profile||candidate.provider!=='kie'||candidate.egress_proxy||process.env.AIAG_EGRESS_PROXY_URL)
    throw errors.unavailable('Media capability unavailable');
  const billing=candidate.billing;
  if(!billing?.pricePerImageCents||!billing.prices?.markup||
    billing.pricePerImageCents!==profile.priceCentsPerUnit||
    billing.prices.markup!==profile.markup)
    throw errors.unavailable('Media pricing unavailable');

  if(routeKind==='image'){
    if(identity.body.n!==1||identity.body.size!==undefined||identity.body.negative_prompt!==undefined||identity.body.reference_image_url!==undefined)
      throw errors.badRequest('Unsupported reviewed image parameters');
  }else{
    if(identity.body.duration_s!==undefined&&identity.body.duration_s!==5)throw errors.badRequest('Unsupported reviewed video duration');
    if(identity.body.aspect_ratio!==undefined&&!['16:9','9:16','1:1'].includes(String(identity.body.aspect_ratio)))
      throw errors.badRequest('Unsupported reviewed video aspect ratio');
  }

  const quote=quoteMediaUnits({priceCentsPerUnit:profile.priceCentsPerUnit,markup:profile.markup},1);
  const adapter=getUpstream(candidate.provider);
  if(!adapter.admittedMedia||adapter.admittedMedia.contract!==profile.adapterContract)
    throw errors.unavailable('Media capability unavailable');
  if(!process.env.AIAG_FORCE_MOCK&&!process.env.KIE_API_KEY)throw errors.unavailable('Media capability unavailable');

  const doSubmit=()=>{
    if(routeKind==='image'){
      if(profile.profileId!=='kie-nano-banana-2-image-v1'||candidate.upstream_model_id!=='nano-banana-2')
        throw errors.unavailable('Media capability unavailable');
      return adapter.admittedMedia!.submit({
        profileId:'kie-nano-banana-2-image-v1',routeKind:'image',modelId:'nano-banana-2',
        prompt:String(identity.body.prompt),
      });
    }
    if(profile.profileId!=='kie-kling-3-video-5s-std-v1'||candidate.upstream_model_id!=='kling-3.0/video'||profile.fixedDurationSec!==5)
      throw errors.unavailable('Media capability unavailable');
    return adapter.admittedMedia!.submit({
      profileId:'kie-kling-3-video-5s-std-v1',routeKind:'video',modelId:'kling-3.0/video',
      prompt:String(identity.body.prompt),durationSec:5,
      ...(identity.body.aspect_ratio?{aspectRatio:String(identity.body.aspect_ratio) as '16:9'|'9:16'|'1:1'}:{}),
      ...(identity.body.image_url?{imageUrl:String(identity.body.image_url)}:{}),
    });
  };
  const attempt=createStoredMediaAttempt({
    identity,orgId,apiKeyId:key.id,clientRequestId:c.get('requestId' as never) as string|null,deadlineAt:deadline(),
    modelSlug:model.slug,modelUpstreamId:billing.modelUpstreamId,upstreamId:candidate.upstream_id,
    upstreamModelId:candidate.upstream_model_id,providerFamily:family(routeKind),quote,
    priceCentsPerUnit:profile.priceCentsPerUnit,markup:profile.markup,submit:doSubmit,enqueue:enqueueOwnedMediaPoll,
  });
  const result=await attempt.run();
  if(result.kind==='replay')return c.json(publicJob(result.job),result.job.status==='completed'?200:202);
  if(result.kind==='queued')return c.json({task_id:result.taskId,status:'queued'},202);
  return c.json({error:{code:'MEDIA_RECONCILIATION_REQUIRED',message:'Media request state unavailable'}},503);
}
storedMedia.post('/images/generations',(c)=>submit(c,'image'));
storedMedia.post('/video/generations',(c)=>submit(c,'video'));
storedMedia.post('/audio/speech',(c)=>submit(c,'audio_speech'));
storedMedia.get('/media/jobs/:taskId',async(c)=>{
  const key=c.get('apiKey' as never) as AuthenticatedApiKey;
  return c.json(publicJob(await readMediaJob(key.org_id,c.req.param('taskId'))));
});
