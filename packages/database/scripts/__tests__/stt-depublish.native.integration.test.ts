import { randomUUID } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { withOwnedAuthorDb } from './author-owned-db.native.fixture';

describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION==='1')('sold-v1 STT depublish database boundary',()=>{
 it('keeps STT out of sellable catalog and durable media admission',async()=>withOwnedAuthorDb(async c=>{
  const rows=(await c.query({text:"SELECT slug,enabled,status,depublished_reason,metadata->>'operation' AS operation FROM models WHERE slug='whisper-large-v3'"})).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({slug:'whisper-large-v3',enabled:false,status:'depublished',depublished_reason:'v1_scope_stt_deferred',operation:'stt'});
  const publicRows=(await c.query({text:"SELECT slug FROM models WHERE enabled=true AND status IN ('live','frozen') AND (metadata->>'operation'='stt' OR slug='whisper-large-v3')"})).rows;
  expect(publicRows).toEqual([]);
  const mappings=(await c.query({text:"SELECT mu.enabled,mu.upstream_id,mu.upstream_model_id FROM model_upstreams mu JOIN models m ON m.id=mu.model_id WHERE m.slug='whisper-large-v3'"})).rows;
  expect(mappings.some((row:any)=>row.upstream_id==='groq'&&row.upstream_model_id==='whisper-large-v3'&&row.enabled===false)).toBe(true);
  await expect(c.query({text:"SELECT * FROM aiag_claim_media_job_v1($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::uuid,$11,$12::bigint,$13::bigint,clock_timestamp()+interval '1 hour',$14::jsonb)",values:[randomUUID(),randomUUID(),randomUUID(),'task_'+'a'.repeat(32),'audio_transcription','b'.repeat(64),'c'.repeat(64),'whisper-large-v3','replicate',randomUUID(),'audio',1000,900,JSON.stringify({model:'whisper-large-v3'})]})).rejects.toThrow(/INVALID_MEDIA_JOB/);
  await expect(c.query({text:"UPDATE models SET enabled=true,status='live' WHERE slug='whisper-large-v3'"})).rejects.toThrow(/STT_SOLD_V1_DISABLED/);
  await expect(c.query({text:"INSERT INTO models(slug,type,enabled,status,display_name,metadata,tags) VALUES($1,'audio',true,'live','Synthetic STT',$2::jsonb,$3::text[])",values:['synthetic-stt-'+randomUUID(),JSON.stringify({operation:'other'}),['audio','STT']]})).rejects.toThrow(/STT_SOLD_V1_DISABLED/);
 }),120000);
 it('blocks a valid STT claim while reviewed mapping is migration-disabled, with no job/hold/money movement',async()=>withOwnedAuthorDb(async c=>{
  const user=randomUUID(),org=randomUUID(),key=randomUUID(),billing=randomUUID();
  await c.query({text:'INSERT INTO users(id,email) VALUES($1::uuid,$2)',values:[user,'disabled-'+user+'@example.test']});
  await c.query({text:"INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES($1::uuid,$2,'disabled',$3::uuid,5000)",values:[org,org,user]});
  await c.query({text:"INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix) VALUES($1::uuid,$2::uuid,'disabled',$3,$4)",values:[key,org,'f'.repeat(64),key.slice(0,16)]});
  const mapping=(await c.query({text:"SELECT mu.id::text FROM model_upstreams mu JOIN models m ON m.id=mu.model_id WHERE m.slug='whisper-large-v3' AND mu.upstream_id='groq' AND mu.enabled=FALSE"})).rows[0]?.id;
  expect(mapping).toMatch(/^[0-9a-f-]{36}$/);
  const input={model:'whisper-large-v3',language:null,format:'pcm_wav',parserContract:'pcm-wav-riff-v1',fileSha256:'e'.repeat(64),byteLength:32044,sampleRate:16000,channels:1,bitsPerSample:16,frames:16000,durationMs:1000,billableMs:10000};
  expect((await c.query({text:"SELECT aiag_valid_transcription_job_input($1::jsonb,'whisper-large-v3') valid",values:[JSON.stringify(input)]})).rows[0].valid).toBe(true);
  await expect(c.query({text:"SELECT * FROM aiag_claim_media_job_v1($1::uuid,$2::uuid,$3::uuid,$4,'audio_transcription',$5,$6,'whisper-large-v3','groq',$7::uuid,'groq_stt',56::bigint,31::bigint,clock_timestamp()+interval '2 minutes',$8::jsonb)",values:[org,key,billing,'task_'+randomUUID().replaceAll('-'),'a'.repeat(64),'b'.repeat(64),mapping,JSON.stringify(input)]})).rejects.toThrow(/MEDIA_CAPABILITY_UNAVAILABLE|INVALID_MEDIA_JOB/);
  expect((await c.query({text:'SELECT count(*)::int n FROM prediction_jobs WHERE org_id=$1::uuid',values:[org]})).rows[0].n).toBe(0);
  expect((await c.query({text:'SELECT count(*)::int n FROM gateway_charge_admissions WHERE org_id=$1::uuid',values:[org]})).rows[0].n).toBe(0);
  expect((await c.query({text:'SELECT payg_credits::text balance FROM organizations WHERE id=$1::uuid',values:[org]})).rows[0].balance).toBe('5000');
 }),120000);

});
