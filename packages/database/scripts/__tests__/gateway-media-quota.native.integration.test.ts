import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPgTestClient } from '../pg-test-client';
import { assertTestDatabaseEnvironment, withGuardedTestDatabase } from '../test-db-guard';
const enabled=process.env.RUN_NATIVE_DB_INTEGRATION==='1'; if(enabled) assertTestDatabaseEnvironment(process.env);

describe.skipIf(!enabled)('native media quota v2',()=>{
 it('reserves exact retail/supplier, validates dispatch and settles completed media once',async()=>{
  await withGuardedTestDatabase(process.env,{clientFactory:createPgTestClient},async(c)=>{
   const user=randomUUID(),org=randomUUID(),key=randomUUID(),id=randomUUID(),attempt=randomUUID(),mapping=randomUUID();
   const upstream='mq-'+randomUUID().slice(0,8), model='media-'+randomUUID();
   const mediaQuote={version:1,formulaVersion:'media-unit-microcredits-v1',routeKind:'image',modelSlug:model,modelUpstreamId:mapping,upstreamId:upstream,upstreamModelId:'fixture/image',providerFamily:'image',units:4,priceCentsPerUnit:'0.015',markup:'1.8',authorizedMaxCredits:'108'};
   const quote={version:1,mediaQuote};
   const supplier={version:2,formulaVersion:'media-supplier-unit-microcredits-v1',mediaQuote};
   const pricing={...mediaQuote,supplierMaxMicrocredits:'60',supplierMaxUsdMicro:'600'};
   try{
    await c.query({text:'INSERT INTO users(id,email) VALUES($1::uuid,$2)',values:[user,'mq-'+user+'@example.test']});
    await c.query({text:"INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES($1::uuid,$2,'mq',$3::uuid,5000)",values:[org,org,user]});
    await c.query({text:"INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix) VALUES($1::uuid,$2::uuid,'mq',$3,$4)",values:[key,org,randomUUID().replaceAll('-').padEnd(64,'0').slice(0,64),key.slice(0,16)]});
    await c.query({text:'INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2) VALUES($1::uuid,2,1000000)',values:[org]});
    await c.query({text:'INSERT INTO gateway_quota_key_policies(api_key_id,org_id) VALUES($1::uuid,$2::uuid)',values:[key,org]});
    const admitted=await c.query({text:"SELECT * FROM aiag_admit_gateway_charge_v2($1::uuid,$2::uuid,$3::uuid,$4::varchar,'image'::varchar,'stored'::varchar,$5::varchar,$6::bigint,$7::jsonb,$8::timestamptz,NULL::varchar,$9::jsonb)",values:[org,id,key,'media-test',model,'108',JSON.stringify(quote),new Date(Date.now()+60000).toISOString(),JSON.stringify(supplier)]});
    expect(admitted.rows[0]?.held_payg_credits).toBe('108');
    const ctx=await c.query({text:'SELECT supplier_authorized_max_usd_micro::text AS supplier FROM gateway_charge_quota_contexts WHERE billing_request_id=$1::uuid',values:[id]});
    expect(ctx.rows[0]?.supplier).toBe('600');
    await c.query({text:'SELECT * FROM aiag_mark_gateway_charge_dispatched($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb)',values:[org,id,attempt,upstream,JSON.stringify(pricing)]});
    const usage={version:1,formulaVersion:'media-unit-microcredits-v1',billingRequestId:id,attemptId:attempt,upstreamId:upstream,terminalStatus:'completed',verified:true};
    await c.query({text:"SELECT * FROM aiag_record_gateway_charge_outcome_v2($1::uuid,$2::uuid,108,$3::jsonb,'success')",values:[org,id,JSON.stringify(usage)]});
    const settled=await c.query({text:'SELECT * FROM aiag_settle_admitted_gateway_charge($1::uuid,$2::uuid)',values:[org,id]});
    expect(settled.rows[0]?.state).toBe('settled');
    const balance=await c.query({text:'SELECT payg_credits::text AS balance FROM organizations WHERE id=$1::uuid',values:[org]});
    expect(balance.rows[0]?.balance).toBe('4892');
    const bucket=await c.query({text:"SELECT settled_amount::text AS settled FROM gateway_quota_buckets WHERE org_id=$1::uuid AND kind='org_day_supplier_v2'",values:[org]});
    expect(bucket.rows[0]?.settled).toBe('600');
   }finally{
    await c.query({text:'DELETE FROM gateway_charge_admission_events WHERE org_id=$1::uuid',values:[org]}).catch(()=>{});
    await c.query({text:'DELETE FROM gateway_quota_buckets WHERE org_id=$1::uuid',values:[org]}).catch(()=>{});
    await c.query({text:'DELETE FROM gateway_charge_quota_contexts WHERE org_id=$1::uuid',values:[org]}).catch(()=>{});
    await c.query({text:'DELETE FROM gateway_charge_admissions WHERE org_id=$1::uuid',values:[org]}).catch(()=>{});
    await c.query({text:'DELETE FROM gateway_quota_key_policies WHERE api_key_id=$1::uuid',values:[key]}).catch(()=>{});
    await c.query({text:'DELETE FROM gateway_quota_org_policies WHERE org_id=$1::uuid',values:[org]}).catch(()=>{});
    await c.query({text:'DELETE FROM gateway_api_keys WHERE id=$1::uuid',values:[key]}).catch(()=>{});
    await c.query({text:'DELETE FROM organizations WHERE id=$1::uuid',values:[org]}).catch(()=>{});
    await c.query({text:'DELETE FROM users WHERE id=$1::uuid',values:[user]}).catch(()=>{});
   }
  });
 },30000);

 it('rounds tiny supplier reserve in the same microcredit unit as the TypeScript quote',async()=>{
  await withGuardedTestDatabase(process.env,{clientFactory:createPgTestClient},async(c)=>{
   const user=randomUUID(),org=randomUUID(),key=randomUUID(),id=randomUUID(),mapping=randomUUID();
   const upstream='mq-tiny-'+randomUUID().slice(0,8), model='media-tiny-'+randomUUID();
   const mediaQuote={version:1,formulaVersion:'media-unit-microcredits-v1',routeKind:'image',modelSlug:model,modelUpstreamId:mapping,upstreamId:upstream,upstreamModelId:'fixture/image',providerFamily:'image',units:1,priceCentsPerUnit:'0.0001',markup:'1.25',authorizedMaxCredits:'1'};
   const quote={version:1,mediaQuote};
   const supplier={version:2,formulaVersion:'media-supplier-unit-microcredits-v1',mediaQuote};
   try{
    await c.query({text:'INSERT INTO users(id,email) VALUES($1::uuid,$2)',values:[user,'mq-tiny-'+user+'@example.test']});
    await c.query({text:"INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES($1::uuid,$2,'mq tiny',$3::uuid,5000)",values:[org,org,user]});
    await c.query({text:"INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix) VALUES($1::uuid,$2::uuid,'mq tiny',$3,$4)",values:[key,org,randomUUID().replaceAll('-').padEnd(64,'0').slice(0,64),key.slice(0,16)]});
    await c.query({text:'INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2) VALUES($1::uuid,2,1000000)',values:[org]});
    await c.query({text:'INSERT INTO gateway_quota_key_policies(api_key_id,org_id) VALUES($1::uuid,$2::uuid)',values:[key,org]});
    await c.query({text:"SELECT * FROM aiag_admit_gateway_charge_v2($1::uuid,$2::uuid,$3::uuid,$4::varchar,'image'::varchar,'stored'::varchar,$5::varchar,1::bigint,$6::jsonb,$7::timestamptz,NULL::varchar,$8::jsonb)",values:[org,id,key,'tiny',model,JSON.stringify(quote),new Date(Date.now()+60000).toISOString(),JSON.stringify(supplier)]});
    const ctx=await c.query({text:'SELECT supplier_authorized_max_usd_micro::text AS supplier FROM gateway_charge_quota_contexts WHERE billing_request_id=$1::uuid',values:[id]});
    expect(ctx.rows[0]?.supplier).toBe('10');
   }finally{
    await c.query({text:'DELETE FROM gateway_charge_admission_events WHERE org_id=$1::uuid',values:[org]}).catch(()=>{});
    await c.query({text:'DELETE FROM gateway_quota_buckets WHERE org_id=$1::uuid',values:[org]}).catch(()=>{});
    await c.query({text:'DELETE FROM gateway_charge_quota_contexts WHERE org_id=$1::uuid',values:[org]}).catch(()=>{});
    await c.query({text:'DELETE FROM gateway_charge_admissions WHERE org_id=$1::uuid',values:[org]}).catch(()=>{});
    await c.query({text:'DELETE FROM gateway_quota_key_policies WHERE api_key_id=$1::uuid',values:[key]}).catch(()=>{});
    await c.query({text:'DELETE FROM gateway_quota_org_policies WHERE org_id=$1::uuid',values:[org]}).catch(()=>{});
    await c.query({text:'DELETE FROM gateway_api_keys WHERE id=$1::uuid',values:[key]}).catch(()=>{});
    await c.query({text:'DELETE FROM organizations WHERE id=$1::uuid',values:[org]}).catch(()=>{});
    await c.query({text:'DELETE FROM users WHERE id=$1::uuid',values:[user]}).catch(()=>{});
   }
  });
 },30000);
});
