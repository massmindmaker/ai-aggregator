import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { MediaJobDb } from '../upstream-poll-db';

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === '1';
function assertLocalTestDb(): string {
  const value = process.env.DATABASE_URL ?? '';
  if (!/^postgres(?:ql)?:\/\/[^/]+@127\.0\.0\.1:15432\//.test(value) || process.env.AIAG_TEST_DATABASE !== '1') {
    throw new Error('native media worker test requires guarded local aggregator test DB');
  }
  return value;
}

type Fixture = {
  user: string; org: string; key: string; billing: string; attempt: string;
  mapping: string; model: string; upstream: string; taskId: string; jobId: string;
};

async function makeFixture(pool: Pool, suffix: string): Promise<Fixture> {
  const user=randomUUID(), org=randomUUID(), key=randomUUID(), billing=randomUUID(), attempt=randomUUID(), mapping=randomUUID();
  const model='media-'+randomUUID(), upstream='mw-'+randomUUID().slice(0,8);
  const taskId='task_'+randomUUID().replaceAll('-','');
  const mediaQuote={version:1,formulaVersion:'media-unit-microcredits-v1',routeKind:'image',modelSlug:model,modelUpstreamId:mapping,upstreamId:upstream,upstreamModelId:'fixture/image',providerFamily:'image',units:4,priceCentsPerUnit:'0.015',markup:'1.8',authorizedMaxCredits:'108'};
  const quote={version:1,mediaQuote};
  const supplier={version:2,formulaVersion:'media-supplier-unit-microcredits-v1',mediaQuote};
  const pricing={...mediaQuote,supplierMaxMicrocredits:'60',supplierMaxUsdMicro:'600'};
  await pool.query('INSERT INTO users(id,email) VALUES($1::uuid,$2)',[user,`media-worker-${suffix}-${user}@example.test`]);
  await pool.query("INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES($1::uuid,$2,'media-worker',$3::uuid,5000)",[org,org,user]);
  await pool.query("INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix) VALUES($1::uuid,$2::uuid,'media-worker',$3,$4)",[key,org,randomUUID().replaceAll('-').padEnd(64,'0').slice(0,64),key.slice(0,16)]);
  await pool.query('INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2) VALUES($1::uuid,2,1000000)',[org]);
  await pool.query('INSERT INTO gateway_quota_key_policies(api_key_id,org_id) VALUES($1::uuid,$2::uuid)',[key,org]);
  await pool.query("SELECT * FROM aiag_admit_gateway_charge_v2($1::uuid,$2::uuid,$3::uuid,$4::varchar,'image'::varchar,'stored'::varchar,$5::varchar,108::bigint,$6::jsonb,$7::timestamptz,NULL::varchar,$8::jsonb)",[org,billing,key,'media-worker-'+suffix,model,JSON.stringify(quote),new Date(Date.now()+120000).toISOString(),JSON.stringify(supplier)]);
  await pool.query('SELECT * FROM aiag_mark_gateway_charge_dispatched($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb)',[org,billing,attempt,upstream,JSON.stringify(pricing)]);
  const claim=await pool.query("SELECT * FROM aiag_claim_media_job_v1($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::uuid,$11,108::bigint,60::bigint,$12::timestamptz,$13::jsonb)",[
    org,key,billing,taskId,'image','a'.repeat(63)+(suffix==='completed'?'1':'2'),'b'.repeat(63)+(suffix==='completed'?'1':'2'),model,upstream,mapping,'image',
    new Date(Date.now()+120000).toISOString(),JSON.stringify({model,prompt:'x',n:4})
  ]);
  const jobId=String(claim.rows[0]!.id);
  await pool.query('SELECT * FROM aiag_attach_media_provider_task_v1($1::uuid,$2::uuid,$3::uuid,$4)',[org,jobId,billing,'jobs:provider-'+suffix]);
  return {user,org,key,billing,attempt,mapping,model,upstream,taskId,jobId};
}

async function cleanup(pool: Pool, f: Fixture): Promise<void> {
  await pool.query('DELETE FROM prediction_jobs WHERE org_id=$1::uuid',[f.org]).catch(()=>{});
  await pool.query('DELETE FROM gateway_transactions WHERE org_id=$1::uuid',[f.org]).catch(()=>{});
  await pool.query('DELETE FROM gateway_charge_admission_events WHERE org_id=$1::uuid',[f.org]).catch(()=>{});
  await pool.query('DELETE FROM gateway_quota_events WHERE org_id=$1::uuid',[f.org]).catch(()=>{});
  await pool.query('DELETE FROM gateway_quota_reservations WHERE billing_request_id=$1::uuid',[f.billing]).catch(()=>{});
  await pool.query('DELETE FROM gateway_quota_buckets WHERE org_id=$1::uuid',[f.org]).catch(()=>{});
  await pool.query('DELETE FROM gateway_charge_quota_contexts WHERE org_id=$1::uuid',[f.org]).catch(()=>{});
  await pool.query('DELETE FROM gateway_charge_admissions WHERE org_id=$1::uuid',[f.org]).catch(()=>{});
  await pool.query('DELETE FROM gateway_quota_key_policies WHERE api_key_id=$1::uuid',[f.key]).catch(()=>{});
  await pool.query('DELETE FROM gateway_quota_org_policies WHERE org_id=$1::uuid',[f.org]).catch(()=>{});
  await pool.query('DELETE FROM gateway_api_keys WHERE id=$1::uuid',[f.key]).catch(()=>{});
  await pool.query('DELETE FROM organizations WHERE id=$1::uuid',[f.org]).catch(()=>{});
  await pool.query('DELETE FROM users WHERE id=$1::uuid',[f.user]).catch(()=>{});
}

describe.skipIf(!enabled)('native durable media worker settlement',()=>{
  it('settles completed media exactly once across duplicate delivery',async()=>{
    const url=assertLocalTestDb(), pool=new Pool({connectionString:url,max:2}), db=new MediaJobDb(url);
    let f:Fixture|undefined;
    try {
      f=await makeFixture(pool,'completed');
      expect(await db.scanRecoverable()).toContain(f.jobId);
      const owned=await db.load(f.jobId); expect(owned).not.toBeNull();
      await db.finalize(owned!,'completed','https://cdn.test/x.png');
      const first=await pool.query("SELECT o.payg_credits::text balance,a.state,a.actual_cost_credits::text actual,p.status,p.output,p.settled_at::text settled,(SELECT count(*)::int FROM gateway_transactions g WHERE g.org_id=o.id AND g.request_id='gw:'||a.billing_request_id::text) receipts FROM organizations o JOIN gateway_charge_admissions a ON a.org_id=o.id JOIN prediction_jobs p ON p.billing_request_id=a.billing_request_id WHERE a.billing_request_id=$1::uuid",[f.billing]);
      expect(first.rows[0]).toMatchObject({balance:'4892',state:'settled',actual:'108',status:'completed',receipts:1});
      expect(first.rows[0].settled).toBeTruthy();
      expect(await db.scanRecoverable()).not.toContain(f.jobId);
      const replay=await db.load(f.jobId); await db.finalize(replay!,'completed','https://cdn.test/x.png');
      const second=await pool.query("SELECT o.payg_credits::text balance,(SELECT count(*)::int FROM gateway_transactions g WHERE g.org_id=o.id AND g.request_id='gw:'||$2) receipts FROM organizations o WHERE o.id=$1::uuid",[f.org,f.billing]);
      expect(second.rows[0]).toEqual({balance:'4892',receipts:1});
    } finally { if(f) await cleanup(pool,f); await db.close(); await pool.end(); }
  },30000);

  it('settles failed media at zero and releases the full hold',async()=>{
    const url=assertLocalTestDb(), pool=new Pool({connectionString:url,max:2}), db=new MediaJobDb(url);
    let f:Fixture|undefined;
    try {
      f=await makeFixture(pool,'failed');
      const owned=await db.load(f.jobId); expect(owned).not.toBeNull();
      await db.finalize(owned!,'failed',undefined,'raw provider failure');
      const row=await pool.query("SELECT o.payg_credits::text balance,a.state,a.actual_cost_credits::text actual,p.status,p.error_message,p.output,(SELECT count(*)::int FROM gateway_transactions g WHERE g.org_id=o.id AND g.request_id='gw:'||a.billing_request_id::text) receipts FROM organizations o JOIN gateway_charge_admissions a ON a.org_id=o.id JOIN prediction_jobs p ON p.billing_request_id=a.billing_request_id WHERE a.billing_request_id=$1::uuid",[f.billing]);
      expect(row.rows[0]).toMatchObject({balance:'5000',state:'settled',actual:'0',status:'failed',error_message:'MEDIA_JOB_FAILED',receipts:0});
      expect(JSON.stringify(row.rows[0].output)).not.toContain('raw provider failure');
    } finally { if(f) await cleanup(pool,f); await db.close(); await pool.end(); }
  },30000);
});
