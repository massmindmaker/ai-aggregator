import { randomUUID } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { withOwnedAuthorDb } from './author-owned-db.native.fixture';

const enabled=process.env.RUN_NATIVE_DB_INTEGRATION==='1';
const query=(db:any,text:string,values:readonly unknown[]=[])=>
  db.query({text,values});

async function createFixture(db:any,suffix:string){
  const user=randomUUID(),org=randomUUID(),key=randomUUID();
  const billing=randomUUID(),attempt=randomUUID();
  const taskId='task_'+randomUUID().replaceAll('-','');
  await query(db,'INSERT INTO users(id,email) VALUES($1::uuid,$2)',[
    user,`stt-${suffix}-${user}@example.test`]);
  await query(db,
    "INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES($1::uuid,$2,'stt',$3::uuid,5000)",
    [org,org,user]);
  await query(db,
    "INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix) VALUES($1::uuid,$2::uuid,'stt',$3,$4)",
    [key,org,randomUUID().replaceAll('-').padEnd(64,'0').slice(0,64),key.slice(0,16)]);
  await query(db,
    'INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2) VALUES($1::uuid,2,1000000)',
    [org]);
  await query(db,
    'INSERT INTO gateway_quota_key_policies(api_key_id,org_id) VALUES($1::uuid,$2::uuid)',
    [key,org]);

  await query(db,"UPDATE upstreams SET enabled=TRUE WHERE id='groq'");
  await query(db,"UPDATE model_upstreams mu SET enabled=TRUE FROM models m WHERE mu.model_id=m.id AND m.slug='whisper-large-v3' AND mu.upstream_id='groq'");
  const mapping=(await query(db,
    "SELECT mu.id::text FROM model_upstreams mu JOIN models m ON m.id=mu.model_id WHERE m.slug='whisper-large-v3' AND mu.upstream_id='groq' AND mu.enabled"
  )).rows[0]?.id;
  expect(mapping).toMatch(/^[0-9a-f-]{36}$/);

  const transcriptionQuote={
    version:1,formulaVersion:'groq-whisper-duration-v1',
    routeKind:'audio_transcription',modelSlug:'whisper-large-v3',
    modelUpstreamId:mapping,upstreamId:'groq',upstreamModelId:'whisper-large-v3',
    providerFamily:'groq_stt',billableMs:10000,rateUsdMicroPerHour:111000,
    markup:'1.8',supplierMaxMicrocredits:'31',supplierMaxUsdMicro:'309',
    authorizedMaxCredits:'56',
  };
  const quote={version:1,transcriptionQuote};
  const supplier={version:2,formulaVersion:'groq-whisper-duration-usd-micro-v1',transcriptionQuote};
  const pricing=transcriptionQuote;
  const digest=(suffix==='a'?'a':'b').repeat(64);
  const fingerprint=(suffix==='a'?'c':'d').repeat(64);
  const input={model:'whisper-large-v3',language:null,format:'pcm_wav',parserContract:'pcm-wav-riff-v1',
    fileSha256:'e'.repeat(64),byteLength:32044,sampleRate:16000,channels:1,bitsPerSample:16,
    frames:16000,durationMs:1000,billableMs:10000};

  const claim=await query(db,
    "SELECT * FROM aiag_claim_media_job_v1($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::uuid,$11,56::bigint,31::bigint,$12::timestamptz,$13::jsonb)",
    [org,key,billing,taskId,'audio_transcription',digest,fingerprint,
      'whisper-large-v3','groq',mapping,'groq_stt',
      new Date(Date.now()+120000).toISOString(),JSON.stringify(input)]);
  expect(claim.rows[0]?.did_claim).toBe(true);

  await query(db,
    "SELECT * FROM aiag_admit_gateway_charge_v2($1::uuid,$2::uuid,$3::uuid,$4::varchar,'audio_transcription'::varchar,'stored'::varchar,'whisper-large-v3'::varchar,56::bigint,$5::jsonb,$6::timestamptz,NULL::varchar,$7::jsonb)",
    [org,billing,key,'stt-'+suffix,JSON.stringify(quote),
      new Date(Date.now()+120000).toISOString(),JSON.stringify(supplier)]);
  await query(db,
    'SELECT * FROM aiag_mark_gateway_charge_dispatched($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb)',
    [org,billing,attempt,'groq',JSON.stringify(pricing)]);
  return {user,org,key,billing,attempt,taskId,
    jobId:String(claim.rows[0]!.id),mapping,digest,fingerprint,input};
}

describe.skipIf(!enabled)('native durable STT settlement',()=>{
  it('persists transcript before settlement and settles exactly once across replay',
    async()=>withOwnedAuthorDb(async db=>{
      const f=await createFixture(db,'a');
      await expect(query(db,
        "UPDATE prediction_jobs SET input=jsonb_set(input,'{durationMs}','2000'::jsonb) WHERE id=$1::uuid",
        [f.jobId])).rejects.toThrow(/STT_JOB_IMMUTABLE/);
      await expect(query(db,'DELETE FROM prediction_jobs WHERE id=$1::uuid',[f.jobId]))
        .rejects.toThrow(/STT_JOB_IMMUTABLE/);
      const output={text:'hello durable transcript'};
      const first=await query(db,
        'SELECT * FROM aiag_record_sync_transcription_result_v1($1::uuid,$2::uuid,$3::uuid,$4::jsonb)',
        [f.org,f.jobId,f.billing,JSON.stringify(output)]);
      expect(first.rows[0]).toEqual({state:'dispatched',did_record:true});
      await expect(query(db,
        'UPDATE prediction_jobs SET settled_at=clock_timestamp() WHERE id=$1::uuid',
        [f.jobId])).rejects.toThrow(/STT_JOB_INVALID_SETTLEMENT/);

      const persisted=(await query(db,
        "SELECT a.state,a.actual_cost_credits,p.status,p.output,p.settled_at::text settled,o.payg_credits::text balance FROM gateway_charge_admissions a JOIN prediction_jobs p ON p.billing_request_id=a.billing_request_id JOIN organizations o ON o.id=a.org_id WHERE a.billing_request_id=$1::uuid",
        [f.billing])).rows[0];
      expect(persisted).toMatchObject({
        state:'dispatched',actual_cost_credits:null,status:'completed',
        output,balance:'4944',settled:null});
      expect((await query(db,
        "SELECT count(*)::int n FROM gateway_transactions WHERE org_id=$1::uuid AND request_id='gw:'||$2",
        [f.org,f.billing])).rows[0].n).toBe(0);

      const usage={version:1,formulaVersion:'groq-whisper-duration-v1',
        billingRequestId:f.billing,attemptId:f.attempt,upstreamId:'groq',
        terminalStatus:'completed',verified:true};
      await query(db,
        "SELECT * FROM aiag_record_gateway_charge_outcome_v2($1::uuid,$2::uuid,56::bigint,$3::jsonb,'success')",
        [f.org,f.billing,JSON.stringify(usage)]);
      const mid=(await query(db,
        "SELECT state,actual_cost_credits::text actual FROM gateway_charge_admissions WHERE billing_request_id=$1::uuid",
        [f.billing])).rows[0];
      expect(mid).toEqual({state:'outcome_recorded',actual:'56'});

      await query(db,
        'SELECT * FROM aiag_settle_admitted_gateway_charge($1::uuid,$2::uuid)',
        [f.org,f.billing]);
      const mark=await query(db,
        'SELECT * FROM aiag_record_sync_transcription_result_v1($1::uuid,$2::uuid,$3::uuid,$4::jsonb)',
        [f.org,f.jobId,f.billing,JSON.stringify(output)]);
      expect(mark.rows[0]).toEqual({state:'settled',did_record:false});

      const final=(await query(db,
        "SELECT a.state,p.settled_at IS NOT NULL settled,o.payg_credits::text balance,(SELECT count(*)::int FROM gateway_transactions g WHERE g.org_id=o.id AND g.request_id='gw:'||a.billing_request_id::text) receipts FROM gateway_charge_admissions a JOIN prediction_jobs p ON p.billing_request_id=a.billing_request_id JOIN organizations o ON o.id=a.org_id WHERE a.billing_request_id=$1::uuid",
        [f.billing])).rows[0];
      expect(final).toEqual({state:'settled',settled:true,balance:'4944',receipts:1});

      await query(db,
        'SELECT * FROM aiag_settle_admitted_gateway_charge($1::uuid,$2::uuid)',
        [f.org,f.billing]);
      const replay=await query(db,
        'SELECT * FROM aiag_record_sync_transcription_result_v1($1::uuid,$2::uuid,$3::uuid,$4::jsonb)',
        [f.org,f.jobId,f.billing,JSON.stringify(output)]);
      expect(replay.rows[0]).toEqual({state:'settled',did_record:false});
      expect((await query(db,
        "SELECT count(*)::int n FROM gateway_transactions WHERE org_id=$1::uuid AND request_id='gw:'||$2",
        [f.org,f.billing])).rows[0].n).toBe(1);
      await expect(query(db,
        'SELECT * FROM aiag_record_sync_transcription_result_v1($1::uuid,$2::uuid,$3::uuid,$4::jsonb)',
        [f.org,f.jobId,f.billing,JSON.stringify({text:'different'})]))
        .rejects.toThrow(/TRANSCRIPTION_RESULT_CONFLICT/);
    }),120000);

  it('keeps unknown provider result dispatched and replays claim without a new billing id',
    async()=>withOwnedAuthorDb(async db=>{
      const f=await createFixture(db,'b');
      const replay=await query(db,
        "SELECT * FROM aiag_claim_media_job_v1($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::uuid,$11,56::bigint,31::bigint,$12::timestamptz,$13::jsonb)",
        [f.org,f.key,randomUUID(),'task_'+randomUUID().replaceAll('-',''),
          'audio_transcription',f.digest,f.fingerprint,'whisper-large-v3',
          'groq',f.mapping,'groq_stt',new Date(Date.now()+120000).toISOString(),
          JSON.stringify(f.input)]);
      expect(replay.rows[0]).toMatchObject({
        id:f.jobId,task_id:f.taskId,billing_request_id:f.billing,did_claim:false});
      const facts=(await query(db,
        "SELECT a.state,a.actual_cost_credits,p.status,p.provider_task_id,p.output,p.settled_at,(SELECT count(*)::int FROM gateway_transactions g WHERE g.org_id=a.org_id AND g.request_id='gw:'||a.billing_request_id::text) receipts FROM gateway_charge_admissions a JOIN prediction_jobs p ON p.billing_request_id=a.billing_request_id WHERE a.billing_request_id=$1::uuid",
        [f.billing])).rows[0];
      expect(facts).toMatchObject({
        state:'dispatched',actual_cost_credits:null,status:'claimed',
        provider_task_id:null,output:null,settled_at:null,receipts:0});
    }),120000);
});
