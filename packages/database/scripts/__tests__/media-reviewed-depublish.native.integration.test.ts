import { describe,expect,it } from 'vitest';
import { withOwnedAuthorDb } from './author-owned-db.native.fixture';
const enabled=process.env.RUN_NATIVE_DB_INTEGRATION==='1';
describe.skipIf(!enabled)('reviewed media stays depublished',()=>{
 it('keeps every Kie media mapping disabled and pins the two reviewed current IDs/prices',async()=>withOwnedAuthorDb(async db=>{
  const rows=(await db.query({text:"SELECT m.slug,m.type,mu.upstream_model_id,mu.price_per_image::text price,mu.markup::text markup,mu.enabled FROM model_upstreams mu JOIN models m ON m.id=mu.model_id WHERE mu.upstream_id='kie' AND m.type IN('image','video','audio') ORDER BY m.slug"})).rows;
  expect(rows.length).toBeGreaterThan(2);expect(rows.every((r:any)=>r.enabled===false)).toBe(true);
  expect(rows.find((r:any)=>r.slug==='nano-banana-2-kie')).toMatchObject({upstream_model_id:'nano-banana-2',price:'4.0000000000',markup:'1.2000',enabled:false});
  expect(rows.find((r:any)=>r.slug==='kling-3-0-kie')).toMatchObject({upstream_model_id:'kling-3.0/video',price:'35.0000000000',markup:'1.2000',enabled:false});
 }),120000);
});
