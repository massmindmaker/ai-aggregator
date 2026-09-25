import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPgTestClient } from '../pg-test-client';
import { assertTestDatabaseEnvironment, withGuardedTestDatabase } from '../test-db-guard';

const enabled=process.env.RUN_NATIVE_DB_INTEGRATION==='1';
if(enabled) assertTestDatabaseEnvironment(process.env);

describe.skipIf(!enabled)('durable media job ownership native',()=>{
  it('claims idempotently, conflicts changed fingerprint, attaches provider once and isolates org read',async()=>{
    await withGuardedTestDatabase(process.env,{clientFactory:createPgTestClient},async(client)=>{
      const user=randomUUID(), org=randomUUID(), other=randomUUID(), key=randomUUID(), billing=randomUUID(), mapping=randomUUID();
      const task='task_'+randomUUID().replaceAll('-','');
      const idem='a'.repeat(64), fp='b'.repeat(64);
      const upstream='media-fixture-'+randomUUID().slice(0,8);
      try {
        await client.query({text:"INSERT INTO users(id,email) VALUES($1::uuid,$2)",values:[user,"media-"+user+"@example.test"]});
        await client.query({text:"INSERT INTO organizations(id,name,slug,status,subscription_credits,payg_credits,owner_id) VALUES($1::uuid,'m','m-'||$1::uuid::text,'active',0,5000,$3::uuid),($2::uuid,'o','o-'||$2::uuid::text,'active',0,5000,$3::uuid)",values:[org,other,user]});
        await client.query({text:"INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix,policies,rpm_limit,batch_rpm_limit,model_whitelist,ru_residency_only) VALUES($1,$2,'k',$3,'sk_test','{}',60,10,'[]',false)",values:[key,org,randomUUID().replaceAll('-','').padEnd(64,'0').slice(0,64)]});
        await client.query({text:"INSERT INTO upstreams(id,provider,ru_residency,enabled,latency_p50_ms,uptime,metadata) VALUES($1,'fixture',false,true,10,.99,'{}')",values:[upstream]});
        const model=randomUUID();
        await client.query({text:"INSERT INTO models(id,slug,type,enabled,status) VALUES($1,$2,'image',true,'live')",values:[model,'media-'+model]});
        await client.query({text:"INSERT INTO model_upstreams(id,model_id,upstream_id,upstream_model_id,price_per_1k_input,price_per_1k_output,price_per_image,markup,enabled,priority) VALUES($1,$2,$3,'fixture/model',0,0,1,1.2,true,1)",values:[mapping,model,upstream]});
        const args=[org,key,billing,task,'image',idem,fp,'media-'+model,upstream,mapping,'image','1200','1000',new Date(Date.now()+60000).toISOString(),JSON.stringify({prompt:'x'})];
        const first=await client.query({text:'SELECT * FROM aiag_claim_media_job_v1($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::uuid,$11,$12::bigint,$13::bigint,$14::timestamptz,$15::jsonb)',values:args});
        expect(first.rows[0]?.did_claim).toBe(true);
        const retryArgs=[...args]; retryArgs[2]=randomUUID(); retryArgs[3]='task_'+randomUUID().replaceAll('-','');
        const second=await client.query({text:'SELECT * FROM aiag_claim_media_job_v1($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::uuid,$11,$12::bigint,$13::bigint,$14::timestamptz,$15::jsonb)',values:retryArgs});
        expect(second.rows[0]?.did_claim).toBe(false);
        expect(second.rows[0]?.billing_request_id).toBe(billing);
        await expect(client.query({text:'SELECT * FROM aiag_claim_media_job_v1($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::uuid,$11,$12::bigint,$13::bigint,$14::timestamptz,$15::jsonb)',values:[...args.slice(0,6),'c'.repeat(64),...args.slice(7)]})).rejects.toThrow(/MEDIA_IDENTITY_CONFLICT/);
        const id=first.rows[0]!.id as string;
        const attached=await client.query({text:'SELECT * FROM aiag_attach_media_provider_task_v1($1::uuid,$2::uuid,$3::uuid,$4)',values:[org,id,billing,'jobs:provider-1']});
        expect(attached.rows[0]?.provider_task_id).toBe('jobs:provider-1');
        await expect(client.query({text:'SELECT * FROM aiag_attach_media_provider_task_v1($1::uuid,$2::uuid,$3::uuid,$4)',values:[org,id,billing,'jobs:provider-2']})).rejects.toThrow(/MEDIA_PROVIDER_TASK_CONFLICT/);
        expect((await client.query({text:'SELECT task_id FROM aiag_read_media_job_v1($1::uuid,$2)',values:[org,task]})).rows).toHaveLength(1);
        expect((await client.query({text:'SELECT task_id FROM aiag_read_media_job_v1($1::uuid,$2)',values:[other,task]})).rows).toHaveLength(0);
      } finally {
        await client.query({text:'DELETE FROM prediction_jobs WHERE org_id=$1',values:[org]}).catch(()=>{});
        await client.query({text:'DELETE FROM model_upstreams WHERE id=$1',values:[mapping]}).catch(()=>{});
        await client.query({text:'DELETE FROM models WHERE slug LIKE $1',values:['media-%']}).catch(()=>{});
        await client.query({text:'DELETE FROM upstreams WHERE id=$1',values:[upstream]}).catch(()=>{});
        await client.query({text:'DELETE FROM gateway_api_keys WHERE id=$1',values:[key]}).catch(()=>{});
        await client.query({text:'DELETE FROM organizations WHERE id=ANY($1::uuid[])',values:[[org,other]]}).catch(()=>{});
        await client.query({text:'DELETE FROM users WHERE id=$1::uuid',values:[user]}).catch(()=>{});
      }
    });
  },30000);
});
