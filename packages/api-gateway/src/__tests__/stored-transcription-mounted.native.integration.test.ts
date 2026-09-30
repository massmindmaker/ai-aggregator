import { createHash,randomUUID } from 'node:crypto';
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { assertTestDatabaseEnvironment,withGuardedTestDatabase } from '../../../database/scripts/test-db-guard';
import { createPgTestClient } from '../../../database/scripts/pg-test-client';
import { discoverNativeMigrations,runNativeMigrations } from '../../../database/scripts/native-migrate';

const enabled=process.env.RUN_NATIVE_DB_INTEGRATION==='1';
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');

function guardNative(){
  assertTestDatabaseEnvironment(process.env);
  const redis=new URL(process.env.REDIS_URL!);
  if(redis.protocol!=='redis:'||redis.hostname!=='127.0.0.1'||redis.port!=='16379')throw Error('STT native requires owned Redis');
}
if(enabled)guardNative();

function wav(seconds=1):Uint8Array{
  const sampleRate=16000,channels=1,bits=16,blockAlign=2,frames=Math.round(seconds*sampleRate),dataBytes=frames*blockAlign;
  const bytes=new Uint8Array(44+dataBytes),v=new DataView(bytes.buffer);
  const text=(at:number,s:string)=>{for(let i=0;i<s.length;i++)bytes[at+i]=s.charCodeAt(i);};
  text(0,'RIFF');v.setUint32(4,36+dataBytes,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);
  v.setUint16(20,1,true);v.setUint16(22,channels,true);v.setUint32(24,sampleRate,true);v.setUint32(28,sampleRate*blockAlign,true);
  v.setUint16(32,blockAlign,true);v.setUint16(34,bits,true);text(36,'data');v.setUint32(40,dataBytes,true);return bytes;
}

let runtime:any,owner:any;
async function createRuntime(){
  guardNative();
  await withGuardedTestDatabase(process.env,{clientFactory:createPgTestClient},async()=>{});
  const migrationClient=await createPgTestClient(process.env.TEST_DATABASE_URL!);
  await migrationClient.connect();
  try{await runNativeMigrations(migrationClient,await discoverNativeMigrations());}
  finally{await migrationClient.end();}
  const names=['GATEWAY_HTTP_EXECUTION_MODE','GROQ_API_KEY','AIAG_FORCE_MOCK'];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  process.env.GATEWAY_HTTP_EXECUTION_MODE='stored_chat_embeddings_completions_stream_media';
  process.env.GROQ_API_KEY='native-groq-stub';
  delete process.env.AIAG_FORCE_MOCK;
  const restore=()=>names.forEach(name=>{const v=previous[name];if(v===undefined)delete process.env[name];else process.env[name]=v;});

  const {default:postgres}=await import('postgres');
  const client=postgres(process.env.TEST_DATABASE_URL!,{max:1,onnotice:()=>{}});
  const other=postgres(process.env.TEST_DATABASE_URL!,{max:1,onnotice:()=>{}});
  await client`UPDATE upstreams SET enabled=TRUE WHERE id='groq'`;
  await client`UPDATE model_upstreams mu SET enabled=TRUE FROM models m WHERE mu.model_id=m.id AND m.slug='whisper-large-v3' AND mu.upstream_id='groq'`;
  const mapping=String((await client`SELECT mu.id::text id FROM model_upstreams mu JOIN models m ON m.id=mu.model_id WHERE m.slug='whisper-large-v3' AND mu.upstream_id='groq' AND mu.enabled`)[0]?.id);
  expect(mapping).toMatch(/^[0-9a-f-]{36}$/);

  const resolver=await import('../routing/resolver');
  resolver.setResolveModelOverride(async(slug)=>({
    slug,type:'audio',candidates:[{
      id:'groq',upstream_id:'groq',upstream_model_id:'whisper-large-v3',provider:'groq',
      price_per_1k_input:0,price_per_1k_output:0,price_per_audio_sec:0.0030833333,
      markup:1.8,latency_p50_ms:10,uptime:0.99,ru_residency:false,egress_proxy:null,priority:1,
      billing:{modelUpstreamId:mapping,prices:{inputCentsPer1k:'0',outputCentsPer1k:'0',markup:'1.8'},pricePerAudioSecondCents:'0.0030833333'},
    }],
  }));
  const provider=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>
    new Response(JSON.stringify({text:'native transcript',duration:1,x_groq:{id:'native-response'}}),{status:200,headers:{'content-type':'application/json'}})
  );
  const {app}=await import('../server');
  const identityModule=await import('../billing/stored-transcription-http-identity');
  const storage=await import('../billing/media-job-storage');
  const quota=await import('../billing/quota-admission');
  const admission=await import('../billing/admission');
  const {parseAdmissionJsonObject}=await import('../billing/admission-result');
  const redisModule=await import('../lib/redis');
  const {sql}=await import('../lib/db');
  await Promise.all([redisModule.redis.ping(),redisModule.makeRedis('ratelimit').ping()]);
  return {app,mapping,identityModule,storage,quota,admission,parseAdmissionJsonObject,client,other,resolver,provider,redisModule,sql,restore,async close(){
    resolver.setResolveModelOverride(null);provider.mockRestore();
    await sql.end().catch(()=>{});await redisModule.redis.quit().catch(()=>{});
    await client.end().catch(()=>{});await other.end().catch(()=>{});restore();
  }};
}
async function createOwner(){
  const user=randomUUID(),org=randomUUID(),key=randomUUID(),token='sk_aiag_test_'+randomUUID().replaceAll('-','');
  await runtime.client.begin(async(tx:any)=>{
    await tx`INSERT INTO users(id,email) VALUES(${user}::uuid,${'stt-'+user+'@example.test'})`;
    await tx`INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES(${org}::uuid,${org},'STT fixture',${user}::uuid,1000)`;
    // F-3: raw audio is PII by construction. The reviewed STT upstream (groq)
    // is not RU-resident, so the residency gate blocks it unless the key
    // explicitly accepts transborder PII. This fixture asserts the durable
    // lifecycle, so it opts in explicitly.
    await tx`INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix,rpm_limit,batch_rpm_limit,policies) VALUES(${key}::uuid,${org}::uuid,'STT key',${sha256(token)},${token.slice(0,20)},10000,10000,'{"allow_pii_transborder":true}'::jsonb)`;
    await tx`INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2) VALUES(${org}::uuid,2,1000000)`;
    await tx`INSERT INTO gateway_quota_key_policies(api_key_id,org_id) VALUES(${key}::uuid,${org}::uuid)`;
  });
  const requestFor=(id:string,bytes=wav(),extra:(form:FormData)=>void=()=>{})=>{
    const form=new FormData();form.set('model','whisper-large-v3');form.set('file',new File([bytes],'speech.wav',{type:'audio/wav'}));extra(form);
    return new Request('http://native.test/v1/audio/transcriptions',{method:'POST',headers:{authorization:'Bearer '+token,'idempotency-key':id},body:form});
  };
  const post=async(id:string,bytes=wav(),extra:(form:FormData)=>void=()=>{})=>runtime.app.fetch(requestFor(id,bytes,extra));
  async function seed(id:string,stage:'held'|'transcript'){
    const captured=await runtime.identityModule.captureStoredTranscriptionHttpRequest(requestFor(id).clone());
    const billingRequestId=randomUUID(),jobUuid=randomUUID(),taskId='task_'+jobUuid.replaceAll('-','');
    const deadlineAt=new Date(Date.now()+5*60_000).toISOString();
    const claim=await runtime.storage.claimMediaJob({
      identity:captured.identity,orgId:org,apiKeyId:key,billingRequestId,taskId,
      modelSlug:'whisper-large-v3',upstreamId:'groq',modelUpstreamId:runtime.mapping,providerFamily:'groq_stt',
      retailMaxMicrocredits:56n,supplierMaxMicrocredits:31n,deadlineAt,
      input:Object.freeze({model:'whisper-large-v3',language:null,format:'pcm_wav',parserContract:'pcm-wav-riff-v1',fileSha256:captured.identity.audioSha256,
        byteLength:captured.identity.audioBytes,sampleRate:captured.identity.sampleRate,channels:captured.identity.channels,
        bitsPerSample:captured.identity.bitsPerSample,frames:captured.identity.frames,durationMs:captured.identity.durationMs,billableMs:captured.identity.billableMs}),
    });
    const transcriptionQuote={version:1,formulaVersion:'groq-whisper-duration-v1',routeKind:'audio_transcription',
      modelSlug:'whisper-large-v3',modelUpstreamId:runtime.mapping,upstreamId:'groq',upstreamModelId:'whisper-large-v3',
      providerFamily:'groq_stt',billableMs:10000,rateUsdMicroPerHour:111000,markup:'1.8',
      supplierMaxMicrocredits:'31',supplierMaxUsdMicro:'309',authorizedMaxCredits:'56'};
    const quoteSnapshot=runtime.parseAdmissionJsonObject({version:1,transcriptionQuote});
    const supplierQuoteSnapshot=runtime.parseAdmissionJsonObject({version:2,formulaVersion:'groq-whisper-duration-usd-micro-v1',transcriptionQuote});
    const held=await runtime.quota.admitGatewayChargeV2({
      orgId:org,apiKeyId:key,clientRequestId:'seed-'+id,billingRequestId,routeKind:'audio_transcription',billingMode:'stored',
      modelSlug:'whisper-large-v3',authorizedMaxCredits:56n,quoteSnapshot,preDispatchDeadlineAt:deadlineAt,
      declaredSessionId:null,supplierQuoteSnapshot,
    });
    if(stage==='held')return {claim,held};
    const dispatched=await runtime.admission.markGatewayChargeDispatched({
      admission:held,attemptId:randomUUID(),upstreamId:'groq',pricingSnapshot:runtime.parseAdmissionJsonObject(transcriptionQuote),
    });
    expect(dispatched.kind).toBe('dispatch_granted');
    await runtime.storage.recordSyncTranscriptionResult({
      orgId:org,jobId:claim.id,billingRequestId,output:{text:'native transcript'},
    });
    return {claim,held,dispatched};
  }
  const facts=async()=>({
    jobs:await runtime.other`SELECT id::text,task_id,route_kind,status,output,settled_at::text FROM prediction_jobs WHERE org_id=${org}::uuid ORDER BY created_at,id`,
    admissions:await runtime.other`SELECT billing_request_id::text,state,authorized_max_credits::text authorized,actual_cost_credits::text actual FROM gateway_charge_admissions WHERE org_id=${org}::uuid ORDER BY created_at,billing_request_id`,
    balance:await runtime.other`SELECT payg_credits::text FROM organizations WHERE id=${org}::uuid`,
    ledger:await runtime.other`SELECT request_id,source,delta::text FROM gateway_transactions WHERE org_id=${org}::uuid ORDER BY id`,
  });
  async function cleanup(){
    const ids=(await runtime.client`SELECT billing_request_id::text id FROM gateway_charge_admissions WHERE org_id=${org}::uuid`).map((r:any)=>String(r.id));
    await runtime.client.begin(async(tx:any)=>{
      await tx`ALTER TABLE prediction_jobs DISABLE TRIGGER transcription_prediction_job_guard_v1`;
      await tx`DELETE FROM prediction_jobs WHERE org_id=${org}::uuid`;
      await tx`ALTER TABLE prediction_jobs ENABLE TRIGGER transcription_prediction_job_guard_v1`;
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
    await runtime.redisModule.redis.del('rl:rpm:'+key);
  }
  return {user,org,key,token,post,seed,facts,cleanup};
}

describe.skipIf(!enabled)('mounted durable STT lifecycle',()=>{
  beforeAll(async()=>{runtime=await createRuntime();},30000);
  beforeEach(async()=>{owner=await createOwner();runtime.provider.mockClear();});
  afterEach(async()=>{await owner.cleanup();});
  afterAll(async()=>{await runtime?.close();});

  it('persists+settles one transcript and exact replay never calls provider twice',async()=>{
    const idem=randomUUID();
    const first=await owner.post(idem);
    expect(first.status,await first.clone().text()).toBe(200);
    expect(await first.json()).toEqual({text:'native transcript'});
    expect(runtime.provider).toHaveBeenCalledTimes(1);
    let facts=await owner.facts();
    expect(facts.jobs).toHaveLength(1);expect(facts.jobs[0]).toMatchObject({route_kind:'audio_transcription',status:'completed',output:{text:'native transcript'}});
    expect(facts.admissions).toHaveLength(1);expect(facts.admissions[0]).toMatchObject({state:'settled',authorized:'56',actual:'56'});
    expect(facts.balance[0]?.payg_credits).toBe('944');expect(facts.ledger).toHaveLength(1);

    const replay=await owner.post(idem);
    expect(replay.status,await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual({text:'native transcript'});
    expect(runtime.provider).toHaveBeenCalledTimes(1);
    facts=await owner.facts();expect(facts.jobs).toHaveLength(1);expect(facts.ledger).toHaveLength(1);

    const changed=await owner.post(idem,wav(2));
    expect(changed.status).toBe(409);expect(runtime.provider).toHaveBeenCalledTimes(1);
  },30000);

  it('recovers a durable held admission by granting dispatch once, then calls provider once',async()=>{
    const idem=randomUUID();await owner.seed(idem,'held');
    let facts=await owner.facts();
    expect(facts.jobs[0]).toMatchObject({status:'claimed',output:null});
    expect(facts.admissions[0]).toMatchObject({state:'held',actual:null});
    expect(facts.balance[0]?.payg_credits).toBe('944');expect(runtime.provider).not.toHaveBeenCalled();
    const response=await owner.post(idem);
    expect(response.status,JSON.stringify({body:await response.clone().text(),providerCalls:runtime.provider.mock.calls.length,facts:await owner.facts()})).toBe(200);
    expect(await response.json()).toEqual({text:'native transcript'});
    expect(runtime.provider).toHaveBeenCalledTimes(1);
    facts=await owner.facts();expect(facts.admissions[0]).toMatchObject({state:'settled',actual:'56'});expect(facts.ledger).toHaveLength(1);
  },30000);

  it('recovers a committed transcript after lost ACK/outcome without another provider POST',async()=>{
    const idem=randomUUID();await owner.seed(idem,'transcript');
    let facts=await owner.facts();
    expect(facts.jobs[0]).toMatchObject({status:'completed',output:{text:'native transcript'}});
    expect(facts.admissions[0]).toMatchObject({state:'dispatched',actual:null});expect(facts.ledger).toHaveLength(0);
    expect(runtime.provider).not.toHaveBeenCalled();
    const response=await owner.post(idem);
    expect(response.status,await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({text:'native transcript'});
    expect(runtime.provider).not.toHaveBeenCalled();
    facts=await owner.facts();expect(facts.admissions[0]).toMatchObject({state:'settled',actual:'56'});expect(facts.ledger).toHaveLength(1);
    const replay=await owner.post(idem);expect(replay.status).toBe(200);expect(runtime.provider).not.toHaveBeenCalled();
    expect((await owner.facts()).ledger).toHaveLength(1);
  },30000);

  it('lost/unknown provider outcome is durable dispatched and replay does not call provider again',async()=>{
    runtime.provider.mockRejectedValueOnce(Error('lost provider response'));
    const idem=randomUUID(),first=await owner.post(idem);
    expect(first.status).toBe(503);expect(runtime.provider).toHaveBeenCalledTimes(1);
    const body=await first.json();expect(body.error.code).toBe('TRANSCRIPTION_RECONCILIATION_REQUIRED');
    let facts=await owner.facts();expect(facts.jobs[0]).toMatchObject({status:'claimed',output:null});
    expect(facts.admissions[0]).toMatchObject({state:'dispatched',actual:null});expect(facts.ledger).toHaveLength(0);
    const replay=await owner.post(idem);
    expect(replay.status).toBe(503);expect(runtime.provider).toHaveBeenCalledTimes(1);
    facts=await owner.facts();expect(facts.admissions).toHaveLength(1);expect(facts.ledger).toHaveLength(0);
  },30000);

  it('invalid WAV and insufficient balance never dispatch provider',async()=>{
    const malformed=await owner.post(randomUUID(),new Uint8Array(100));
    expect(malformed.status).toBe(400);expect(runtime.provider).not.toHaveBeenCalled();
    await runtime.client`UPDATE organizations SET payg_credits=0 WHERE id=${owner.org}::uuid`;
    const noFunds=await owner.post(randomUUID());
    expect(noFunds.status).toBe(402);expect(runtime.provider).not.toHaveBeenCalled();
    const facts=await owner.facts();expect(facts.jobs).toHaveLength(0);expect(facts.admissions).toHaveLength(0);
  },30000);

  it('BYOK is rejected before provider/storage work',async()=>{
    const form=new FormData();form.set('model','whisper-large-v3');form.set('file',new File([wav()],'x.wav',{type:'audio/wav'}));
    const response=await runtime.app.fetch(new Request('http://native.test/v1/audio/transcriptions',{method:'POST',headers:{authorization:'Bearer '+owner.token,'idempotency-key':randomUUID(),'x-upstream-key':'secret'},body:form}));
    expect(response.status).toBe(501);expect(runtime.provider).not.toHaveBeenCalled();
    const facts=await owner.facts();expect(facts.jobs).toHaveLength(0);expect(facts.admissions).toHaveLength(0);
  },30000);
});
