export type ReviewedMediaIdentity=Readonly<{
 routeKind:'image'|'video';modelSlug:string;modelType:string;upstreamId:string;upstreamModelId:string;adapterKey:string;
}>;
export type ReviewedMediaProfile=ReviewedMediaIdentity&Readonly<{
 version:1;profileId:'kie-nano-banana-2-image-v1'|'kie-kling-3-video-5s-std-v1';revision:1;
 adapterContract:'kie-market-reviewed-media-v1';priceCentsPerUnit:'4.00'|'35.00';markup:'1.2000';
 fixedDurationSec:null|5;fixedResolution:'1K'|'720p';evidence:readonly Readonly<{url:string;checkedAt:string}>[];
}>;
const entries:ReviewedMediaProfile[]=[
 {version:1,profileId:'kie-nano-banana-2-image-v1',revision:1,routeKind:'image',modelSlug:'nano-banana-2-kie',modelType:'image',
  upstreamId:'kie',upstreamModelId:'nano-banana-2',adapterKey:'kie',adapterContract:'kie-market-reviewed-media-v1',
  priceCentsPerUnit:'4.00',markup:'1.2000',fixedDurationSec:null,fixedResolution:'1K',
  evidence:[{url:'https://docs.kie.ai/market/google/nanobanana2',checkedAt:'2026-09-29'},{url:'https://kie.ai/pricing',checkedAt:'2026-09-29'}]},
 {version:1,profileId:'kie-kling-3-video-5s-std-v1',revision:1,routeKind:'video',modelSlug:'kling-3-0-kie',modelType:'video',
  upstreamId:'kie',upstreamModelId:'kling-3.0/video',adapterKey:'kie',adapterContract:'kie-market-reviewed-media-v1',
  priceCentsPerUnit:'35.00',markup:'1.2000',fixedDurationSec:5,fixedResolution:'720p',
  evidence:[{url:'https://docs.kie.ai/market/kling/kling-3-0',checkedAt:'2026-09-29'},{url:'https://kie.ai/pricing',checkedAt:'2026-09-29'}]},
];
const keys=['routeKind','modelSlug','modelType','upstreamId','upstreamModelId','adapterKey'] as const;
const ids=new Set<string>(),tuples=new Set<string>();
for(const p of entries){
 const tuple=JSON.stringify(keys.map(k=>p[k]));
 const exactImage=p.profileId==='kie-nano-banana-2-image-v1'&&p.routeKind==='image'&&p.modelSlug==='nano-banana-2-kie'&&p.modelType==='image'&&p.upstreamModelId==='nano-banana-2'&&p.priceCentsPerUnit==='4.00'&&p.markup==='1.2000'&&p.fixedDurationSec===null&&p.fixedResolution==='1K';
 const exactVideo=p.profileId==='kie-kling-3-video-5s-std-v1'&&p.routeKind==='video'&&p.modelSlug==='kling-3-0-kie'&&p.modelType==='video'&&p.upstreamModelId==='kling-3.0/video'&&p.priceCentsPerUnit==='35.00'&&p.markup==='1.2000'&&p.fixedDurationSec===5&&p.fixedResolution==='720p';
 if(p.version!==1||p.revision!==1||p.upstreamId!=='kie'||p.adapterKey!=='kie'||p.adapterContract!=='kie-market-reviewed-media-v1'||
   ids.has(p.profileId)||tuples.has(tuple)||(!exactImage&&!exactVideo)||
   p.evidence.length<2||p.evidence.some(e=>new URL(e.url).protocol!=='https:'||!/^\d{4}-\d{2}-\d{2}$/.test(e.checkedAt)))throw new Error('Invalid reviewed media manifest');
 ids.add(p.profileId);tuples.add(tuple);p.evidence.forEach(Object.freeze);Object.freeze(p.evidence);Object.freeze(p);
}
export const reviewedMediaProfiles:readonly ReviewedMediaProfile[]=Object.freeze(entries);
export function findReviewedMediaProfile(identity:ReviewedMediaIdentity):ReviewedMediaProfile|null{
 return reviewedMediaProfiles.find(p=>keys.every(k=>p[k]===identity[k]))??null;
}
