import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTestDatabaseEnvironment, withGuardedTestDatabase } from '../../../database/scripts/test-db-guard';
import { createPgTestClient } from '../../../database/scripts/pg-test-client';

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === '1';
const sha256 = (value:string)=>createHash('sha256').update(value).digest('hex');

function guardNative() {
  assertTestDatabaseEnvironment(process.env);
  const redis = new URL(process.env.REDIS_URL!);
  if (redis.protocol !== 'redis:' || redis.hostname !== '127.0.0.1' || redis.port !== '16379' || redis.search || !['','/','/0'].includes(redis.pathname))
    throw new Error('stored media native proof requires dedicated Redis 127.0.0.1:16379/0');
}
if (enabled) guardNative();

type Owner = Awaited<ReturnType<typeof createOwner>>;
let runtime: Awaited<ReturnType<typeof createRuntime>>;
let owner: Owner;

async function createRuntime() {
  guardNative();
  await withGuardedTestDatabase(process.env,{clientFactory:createPgTestClient},async()=>{});
  const names=['GATEWAY_HTTP_EXECUTION_MODE','KIE_API_KEY','AIAG_FORCE_MOCK'];
  const previous=Object.fromEntries(names.map((name)=>[name,process.env[name]]));
  process.env.GATEWAY_HTTP_EXECUTION_MODE='stored_chat_embeddings_completions_stream_media';
  process.env.KIE_API_KEY='native-media-stub';
  delete process.env.AIAG_FORCE_MOCK;
  const restore=()=>names.forEach((name)=>{const value=previous[name]; if(value===undefined) delete process.env[name]; else process.env[name]=value;});

  const {default:postgres}=await import('postgres');
  const client=postgres(process.env.TEST_DATABASE_URL!,{max:1,onnotice:()=>{}});
  const other=postgres(process.env.TEST_DATABASE_URL!,{max:1,onnotice:()=>{}});
  const {sql}=await import('../lib/db');
  const redisModule=await import('../lib/redis');
  const resolver=await import('../routing/resolver');
  const mapping={image:randomUUID(),video:randomUUID(),audio:randomUUID()};
  resolver.setResolveModelOverride(async(slug)=>{
    const kind=slug.endsWith('/image')?'image':slug.endsWith('/video')?'video':'audio';
    return {
      slug,
      type:kind,
      candidates:[{
        id:'kie',upstream_id:'kie',upstream_model_id:kind==='video'?'veo-native':kind==='audio'?'suno-native':'image-native',provider:'kie',
        price_per_1k_input:0,price_per_1k_output:0,price_per_image:0.015,markup:1.8,latency_p50_ms:10,uptime:0.99,ru_residency:false,egress_proxy:null,priority:1,
        billing:{modelUpstreamId:mapping[kind],prices:{inputCentsPer1k:'0',outputCentsPer1k:'0',markup:'1.8'},pricePerImageCents:'0.015'},
      }],
    };
  });

  const {kieUpstream}=await import('../upstreams/kie');
  const image=vi.spyOn(kieUpstream,'imageGeneration').mockResolvedValue({status:'queued',job_id:'jobs:native-image'});
  const video=vi.spyOn(kieUpstream,'videoGeneration').mockResolvedValue({status:'queued',job_id:'veo:native-video'});
  const audio=vi.spyOn(kieUpstream,'audioSpeech').mockResolvedValue({status:'queued',job_id:'suno:native-audio'});
  const network=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw new Error('stored media native external network forbidden');});
  const {app}=await import('../server');
  const {Queue}=await import('bullmq');
  const queue=new Queue('upstream-poll',{connection:{host:'127.0.0.1',port:16379}});
  const {MediaJobDb}=await import('../../../../apps/worker/src/queues/upstream-poll-db');
  const mediaDb=new MediaJobDb(process.env.TEST_DATABASE_URL!);
  await Promise.all([redisModule.redis.ping(),redisModule.makeRedis('ratelimit').ping()]);

  async function close(){
    resolver.setResolveModelOverride(null);
    image.mockRestore();video.mockRestore();audio.mockRestore();network.mockRestore();
    await mediaDb.close().catch(()=>{});
    await queue.close().catch(()=>{});
    await sql.end().catch(()=>{});
    await redisModule.redis.quit().catch(()=>{});
    await client.end().catch(()=>{});await other.end().catch(()=>{});
    restore();
  }
  return {app,client,other,redis:redisModule.redis,queue,mediaDb,image,video,audio,close};
}

async function createOwner() {
  const user=randomUUID(),org=randomUUID(),key=randomUUID();
  const token='sk_aiag_test_'+randomUUID().replaceAll('-','');
  await runtime.client.begin(async(tx)=>{
    await tx`INSERT INTO users(id,email) VALUES(${user}::uuid,${'media-'+user+'@example.test'})`;
    await tx`INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES(${org}::uuid,${org},'Media native fixture',${user}::uuid,1000)`;
    await tx`INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix,rpm_limit,batch_rpm_limit) VALUES(${key}::uuid,${org}::uuid,'Media key',${sha256(token)},${token.slice(0,20)},10000,10000)`;
    await tx`INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2) VALUES(${org}::uuid,2,1000000)`;
    await tx`INSERT INTO gateway_quota_key_policies(api_key_id,org_id) VALUES(${key}::uuid,${org}::uuid)`;
  });
  const post=(path:string,id:string,body:unknown)=>runtime.app.fetch(new Request('http://native.test'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':id},body:JSON.stringify(body)}));
  const get=(taskId:string)=>runtime.app.fetch(new Request('http://native.test/v1/media/jobs/'+taskId,{headers:{authorization:'Bearer '+token}}));
  const facts=async()=>({
    jobs:await runtime.other`SELECT id::text,task_id,route_kind,status,provider_task_id,quoted_retail_microcredits::text retail,quoted_supplier_microcredits::text supplier,output,settled_at::text FROM prediction_jobs WHERE org_id=${org}::uuid ORDER BY created_at,id`,
    admissions:await runtime.other`SELECT billing_request_id::text,route_kind,state,authorized_max_credits::text authorized,actual_cost_credits::text actual FROM gateway_charge_admissions WHERE org_id=${org}::uuid ORDER BY created_at,billing_request_id`,
    balance:await runtime.other`SELECT payg_credits::text FROM organizations WHERE id=${org}::uuid`,
    ledger:await runtime.other`SELECT request_id,source,delta::text FROM gateway_transactions WHERE org_id=${org}::uuid ORDER BY id`,
  });
  async function cleanup(){
    const rows=await runtime.client`SELECT id::text,billing_request_id::text FROM prediction_jobs WHERE org_id=${org}::uuid`;
    for(const row of rows){const job=await runtime.queue.getJob('media-'+String(row.id));if(job)await job.remove().catch(()=>{});}
    const ids=(await runtime.client`SELECT billing_request_id::text id FROM gateway_charge_admissions WHERE org_id=${org}::uuid`).map((r)=>String(r.id));
    await runtime.client.begin(async(tx)=>{
      await tx`DELETE FROM prediction_jobs WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_charge_quota_events WHERE billing_request_id=ANY(${tx.array(ids)}::uuid[])`;
      await tx`DELETE FROM gateway_charge_quota_reservations WHERE billing_request_id=ANY(${tx.array(ids)}::uuid[])`;
      await tx`DELETE FROM gateway_charge_quota_contexts WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_quota_buckets WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_transactions WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_charge_admission_events WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_charge_admissions WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_quota_key_policies WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_quota_org_policies WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_api_keys WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM organizations WHERE id=${org}::uuid`;
      await tx`DELETE FROM users WHERE id=${user}::uuid`;
    });
    await runtime.redis.del('rl:rpm:'+key,'rl:batch:'+key);
  }
  return {user,org,key,token,post,get,facts,cleanup};
}

describe.skipIf(!enabled)('guarded mounted durable async media lifecycle',()=>{
  beforeAll(async()=>{runtime=await createRuntime();},30000);
  beforeEach(async()=>{owner=await createOwner();runtime.image.mockClear();runtime.video.mockClear();runtime.audio.mockClear();});
  afterEach(async()=>{await owner.cleanup();});
  afterAll(async()=>{await runtime?.close();});

  it('owns image/video/audio jobs before 202, queues only opaque job ids, settles once, and replays without provider',async()=>{
    const cases=[
      {path:'/v1/images/generations',id:randomUUID(),body:{model:'native/image',prompt:'cat',n:2},route:'image',retail:'54',provider:runtime.image},
      {path:'/v1/video/generations',id:randomUUID(),body:{model:'native/video',prompt:'sunset'},route:'video',retail:'27',provider:runtime.video},
      {path:'/v1/audio/speech',id:randomUUID(),body:{model:'native/audio',input:'hello'},route:'audio_speech',retail:'27',provider:runtime.audio},
    ] as const;
    const tasks:string[]=[];
    for(const item of cases){
      const response=await owner.post(item.path,item.id,item.body);
      expect(response.status,await response.clone().text()).toBe(202);
      const body=await response.json() as {task_id:string;status:string};
      expect(body.status).toBe('queued'); expect(body.task_id).toMatch(/^task_[0-9a-f]{32}$/); tasks.push(body.task_id);
      expect(JSON.stringify(body)).not.toMatch(/jobs:|veo:|suno:/);
      expect(item.provider).toHaveBeenCalledTimes(1);
      const rows=(await owner.facts()).jobs.filter((row)=>row.task_id===body.task_id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({route_kind:item.route,status:'queued',retail:item.retail});
      const queued=await runtime.queue.getJob('media-'+String(rows[0]!.id));
      expect(queued?.data).toEqual({jobId:String(rows[0]!.id)});
      expect(JSON.stringify(queued?.data)).not.toMatch(/provider|prompt|secret/i);
    }
    let facts=await owner.facts();
    expect(facts.balance[0]?.payg_credits).toBe('892');
    expect(facts.admissions.map((row)=>({route:row.route_kind,state:row.state,authorized:row.authorized}))).toEqual([
      {route:'image',state:'dispatched',authorized:'54'},
      {route:'video',state:'dispatched',authorized:'27'},
      {route:'audio_speech',state:'dispatched',authorized:'27'},
    ]);

    const providerCalls=runtime.image.mock.calls.length+runtime.video.mock.calls.length+runtime.audio.mock.calls.length;
    const queuedGet=await owner.get(tasks[0]!); expect(queuedGet.status).toBe(200);
    expect(await queuedGet.json()).toMatchObject({task_id:tasks[0],status:'queued'});
    expect(runtime.image.mock.calls.length+runtime.video.mock.calls.length+runtime.audio.mock.calls.length).toBe(providerCalls);

    for(const taskId of tasks){
      const job=(await owner.facts()).jobs.find((row)=>row.task_id===taskId)!;
      const owned=await runtime.mediaDb.load(String(job.id)); expect(owned).not.toBeNull();
      await runtime.mediaDb.finalize(owned!,'completed','https://cdn.test/'+taskId);
    }
    facts=await owner.facts();
    expect(facts.balance[0]?.payg_credits).toBe('892');
    expect(facts.admissions.every((row)=>row.state==='settled')).toBe(true);
    expect(facts.admissions.map((row)=>row.actual).sort()).toEqual(['27','27','54']);
    expect(facts.ledger).toHaveLength(3);

    const completed=await owner.get(tasks[0]!); expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({task_id:tasks[0],status:'completed',output:'https://cdn.test/'+tasks[0]});
    const replay=await owner.post(cases[0].path,cases[0].id,cases[0].body);
    expect(replay.status).toBe(200); expect(runtime.image).toHaveBeenCalledTimes(1);
    expect((await owner.facts()).ledger).toHaveLength(3);

    const changed=await owner.post(cases[0].path,cases[0].id,{...cases[0].body,prompt:'changed'});
    expect(changed.status).toBe(409);
    expect(runtime.image).toHaveBeenCalledTimes(1);
  },30000);

  it('keeps task reads org-scoped and never polls provider from GET',async()=>{
    const id=randomUUID();
    const created=await owner.post('/v1/images/generations',id,{model:'native/image',prompt:'private'});
    expect(created.status,await created.clone().text()).toBe(202);
    const task=String((await created.json() as {task_id:string}).task_id);
    const foreign=await createOwner();
    try{
      const before=runtime.image.mock.calls.length;
      expect((await foreign.get(task)).status).toBe(404);
      expect(runtime.image.mock.calls.length).toBe(before);
    } finally { await foreign.cleanup(); }
  },30000);
  it('releases a rejected admission claim and preserves the insufficient-balance error',async()=>{
    await runtime.client`UPDATE organizations SET payg_credits=0 WHERE id=${owner.org}::uuid`;
    const before=runtime.image.mock.calls.length;
    const response=await owner.post('/v1/images/generations',randomUUID(),{model:'native/image',prompt:'no funds'});
    expect(response.status,await response.clone().text()).toBe(402);
    expect(runtime.image.mock.calls.length).toBe(before);
    const facts=await owner.facts();
    expect(facts.jobs).toHaveLength(0);
    expect(facts.admissions).toHaveLength(0);
  },30000);

  it('rejects a model whose registry type does not match the media route before provider dispatch',async()=>{
    const before=runtime.image.mock.calls.length;
    const response=await owner.post('/v1/images/generations',randomUUID(),{model:'native/video',prompt:'wrong route'});
    expect(response.status,await response.clone().text()).toBe(400);
    expect(runtime.image.mock.calls.length).toBe(before);
    expect((await owner.facts()).jobs).toHaveLength(0);
  },30000);

  it('rejects malformed JSON before claim, admission, or provider dispatch',async()=>{
    const before=runtime.image.mock.calls.length;
    const response=await runtime.app.fetch(new Request('http://native.test/v1/images/generations',{
      method:'POST',
      headers:{authorization:'Bearer '+owner.token,'content-type':'application/json','idempotency-key':randomUUID()},
      body:'{"model":"native/image","prompt":',
    }));
    expect(response.status,await response.clone().text()).toBe(400);
    expect(runtime.image.mock.calls.length).toBe(before);
    const facts=await owner.facts();
    expect(facts.jobs).toHaveLength(0);
    expect(facts.admissions).toHaveLength(0);
  },30000);

  it('fails closed before media dispatch when egress proxying is configured but worker polling cannot preserve it',async()=>{
    const previous=process.env.AIAG_EGRESS_PROXY_URL;
    process.env.AIAG_EGRESS_PROXY_URL='http://127.0.0.1:18080';
    try{
      const before=runtime.image.mock.calls.length;
      const response=await owner.post('/v1/images/generations',randomUUID(),{model:'native/image',prompt:'proxy required'});
      expect(response.status,await response.clone().text()).toBe(503);
      expect(runtime.image.mock.calls.length).toBe(before);
      expect((await owner.facts()).jobs).toHaveLength(0);
    }finally{
      if(previous===undefined)delete process.env.AIAG_EGRESS_PROXY_URL;else process.env.AIAG_EGRESS_PROXY_URL=previous;
    }
  },30000);

});
