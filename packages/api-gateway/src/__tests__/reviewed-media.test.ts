import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { reviewedMediaProfiles,findReviewedMediaProfile } from '../billing/reviewed-media-profiles';
import { kieUpstream } from '../upstreams/kie';

const fetchMock=vi.spyOn(globalThis,'fetch');
beforeEach(()=>{process.env.KIE_API_KEY='test-kie';delete process.env.AIAG_EGRESS_PROXY_URL;fetchMock.mockReset();});
afterEach(()=>{delete process.env.KIE_API_KEY;delete process.env.AIAG_EGRESS_PROXY_URL;});

describe('reviewed current Kie media contracts',()=>{
 it('pins exactly the current reviewed image/video profiles',()=>{
  expect(reviewedMediaProfiles.map(p=>[p.modelSlug,p.upstreamModelId,p.priceCentsPerUnit,p.fixedDurationSec])).toEqual([
   ['nano-banana-2-kie','nano-banana-2','4.00',null],
   ['kling-3-0-kie','kling-3.0/video','35.00',5],
  ]);
  expect(findReviewedMediaProfile({routeKind:'image',modelSlug:'nano-banana-2-kie',modelType:'image',upstreamId:'kie',upstreamModelId:'google/nano-banana-2',adapterKey:'kie'})).toBeNull();
 });
 it('submits Nano Banana 2 with fixed 1K reviewed input shape',async()=>{
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({code:200,msg:'success',data:{taskId:'img-1'}}),{status:200,headers:{'content-type':'application/json'}}));
  const result=await kieUpstream.admittedMedia!.submit({profileId:'kie-nano-banana-2-image-v1',routeKind:'image',modelId:'nano-banana-2',prompt:'cat'});
  expect(result.job_id).toBe('jobs:img-1');
  const [,init]=fetchMock.mock.calls[0]!;
  expect(JSON.parse(String(init?.body))).toEqual({model:'nano-banana-2',input:{prompt:'cat',aspect_ratio:'1:1',resolution:'1K',output_format:'jpg',image_input:[]}});
 });
 it('submits Kling 3.0 as fixed 5s std and never accepts a mismatched reviewed identity',async()=>{
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({code:200,msg:'success',data:{taskId:'vid-1'}}),{status:200,headers:{'content-type':'application/json'}}));
  const result=await kieUpstream.admittedMedia!.submit({profileId:'kie-kling-3-video-5s-std-v1',routeKind:'video',modelId:'kling-3.0/video',prompt:'sunset',durationSec:5,aspectRatio:'9:16'});
  expect(result.job_id).toBe('jobs:vid-1');
  const [,init]=fetchMock.mock.calls[0]!;
  expect(JSON.parse(String(init?.body))).toEqual({model:'kling-3.0/video',input:{prompt:'sunset',sound:false,duration:'5',aspect_ratio:'9:16',mode:'std',multi_shots:false}});
  await expect(kieUpstream.admittedMedia!.submit({profileId:'kie-kling-3-video-5s-std-v1',routeKind:'image',modelId:'nano-banana-2',prompt:'bad'})).rejects.toThrow(/contract mismatch/);
 });
});
