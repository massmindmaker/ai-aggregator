import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { assertTestDatabaseEnvironment } from '../../../database/scripts/test-db-guard';
import { sql } from '../lib/db';
import { prepareStoredChatExecution } from '../billing/stored-chat-execution-preparation';
import {
  claimNextStoredBatchItem,
  completeStoredBatchItemFromPendingEvidence,
  createOrReplayStoredBatch,
  hasQueuedStoredBatchItems,
  listRecoverableStoredBatches,
  listStoredBatchEvidenceRecoveryCandidates,
  loadStoredBatchPendingEvidence,
  loadStoredBatchItem,
  markStoredBatchQueued,
  markStoredBatchItemTerminal,
  markStoredBatchQueueRecoveryNeeded,
  readStoredBatch,
  readStoredBatchResults,
  reconcileStaleStoredBatchProcessing,
  recordStoredBatchPendingEvidence,
  releaseStoredBatchItemClaimForRetry,
  refreshStoredBatchAggregate,
  StoredBatchConflictError,
} from '../billing/stored-batch-storage';

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === '1';
if (enabled) assertTestDatabaseEnvironment(process.env);
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

function model() {
  return {
    slug:'openai/gpt-4o-mini', type:'chat',
    candidates:[{
      id:'openrouter',upstream_id:'openrouter',upstream_model_id:'openai/gpt-4o-mini',
      provider:'openai',price_per_1k_input:1,price_per_1k_output:1,markup:1,
      latency_p50_ms:1,uptime:1,ru_residency:false,
      billing:{modelUpstreamId:uuid(3),prices:{inputCentsPer1k:'0.1234567890',outputCentsPer1k:'0.5',markup:'1.25'}},
    }],
  } as any;
}
const adapter={
  admittedChat:{contract:'openrouter-pinned-provider-chat-v1' as const,execute:async()=>{throw new Error('not executed');}},
  chat:async()=>{throw new Error('legacy');},
};

function item(index:number, customId:string, orgId:string, apiKeyId:string, next:()=>string) {
  const body={model:'openai/gpt-4o-mini',messages:[{role:'user' as const,content:`prompt-${index}`}]};
  const execution=prepareStoredChatExecution({
    orgId,apiKeyId,clientRequestId:'batch-trace',declaredSessionId:'Batch.SID',
    model:model(),requestedMode:'fastest',policy:{},body,
    defaultMaxOutputTokens:4096,cachingDiscount:'0.5',
    preDispatchDeadlineAt:new Date(Date.now()+60_000).toISOString(),
  },{getAdapter:()=>adapter as any,newUuid:next});
  if(execution.status!=='ready') throw new Error(execution.status);
  return Object.freeze({
    index,customId,routeKind:'chat' as const,
    requestFingerprint:String(index+1).repeat(64).slice(0,64),
    requestBody:Object.freeze({model:body.model,messages:Object.freeze(body.messages),stream:false as const}),
    execution,
  });
}

const fixtures:Array<{user:string;org:string;key:string}>=[];

async function fixture(payg:bigint){
  const f={user:randomUUID(),org:randomUUID(),key:randomUUID()}; fixtures.push(f);
  await sql`INSERT INTO users(id,email) VALUES(${f.user}::uuid,${'batch-'+f.user+'@example.test'})`;
  await sql`INSERT INTO organizations(id,slug,name,owner_id,subscription_credits,payg_credits)
    VALUES(${f.org}::uuid,${'batch-'+f.org},'Batch fixture',${f.user}::uuid,0,${payg.toString()}::bigint)`;
  await sql`INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix,policies,rpm_limit,batch_rpm_limit,model_whitelist,ru_residency_only)
    VALUES(${f.key}::uuid,${f.org}::uuid,'Batch key',${randomUUID().replaceAll('-','').padEnd(64,'0').slice(0,64)},'sk_test','{}',100,100,'[]',false)`;
  await sql`INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2)
    VALUES(${f.org}::uuid,2,1000000000)`;
  return f;
}

afterEach(async()=>{
  const failures:unknown[]=[];
  const cleanup=async(operation:()=>Promise<unknown>)=>{
    try{await operation();}catch(error){failures.push(error);}
  };
  for(const f of fixtures.splice(0)){
    await cleanup(()=>sql`DELETE FROM batches WHERE org_id=${f.org}::uuid`);
    await cleanup(()=>sql`DELETE FROM gateway_charge_quota_events WHERE billing_request_id IN (SELECT billing_request_id FROM gateway_charge_admissions WHERE org_id=${f.org}::uuid)`);
    await cleanup(()=>sql`DELETE FROM gateway_charge_quota_reservations WHERE billing_request_id IN (SELECT billing_request_id FROM gateway_charge_admissions WHERE org_id=${f.org}::uuid)`);
    await cleanup(()=>sql`DELETE FROM gateway_charge_quota_contexts WHERE billing_request_id IN (SELECT billing_request_id FROM gateway_charge_admissions WHERE org_id=${f.org}::uuid)`);
    await cleanup(()=>sql`DELETE FROM gateway_charge_admission_events WHERE org_id=${f.org}::uuid`);
    await cleanup(()=>sql`DELETE FROM gateway_quota_buckets WHERE org_id=${f.org}::uuid`);
    await cleanup(()=>sql`DELETE FROM gateway_quota_key_policies WHERE org_id=${f.org}::uuid`);
    await cleanup(()=>sql`DELETE FROM gateway_quota_org_policies WHERE org_id=${f.org}::uuid`);
    await cleanup(()=>sql`DELETE FROM gateway_charge_admissions WHERE org_id=${f.org}::uuid`);
    await cleanup(()=>sql`DELETE FROM gateway_api_keys WHERE id=${f.key}::uuid`);
    await cleanup(()=>sql`DELETE FROM organizations WHERE id=${f.org}::uuid`);
    await cleanup(()=>sql`DELETE FROM users WHERE id=${f.user}::uuid`);
  }
  if(failures.length) throw new AggregateError(failures,'Stored batch fixture cleanup failed');
});

describe.skipIf(!enabled)('stored batch atomic storage native',()=>{
  it('rolls back parent, items, admissions, quota reservations and balance when a later item cannot be funded',async()=>{
    const f=await fixture(30_000n);
    let n=100; const next=()=>uuid(n++);
    const items=[item(0,'a',f.org,f.key,next),item(1,'b',f.org,f.key,next)];
    const billingIds=items.map(x=>x.execution.status==='ready'?x.execution.billingRequestId:'');
    const before=(await sql<{payg_credits:string}[]>`SELECT payg_credits::text FROM organizations WHERE id=${f.org}::uuid`)[0]!.payg_credits;
    const holds=items.map((value)=>value.execution.status==='ready'?value.execution.admissionArgs.authorizedMaxCredits:0n);
    expect(holds[0]).toBeLessThanOrEqual(BigInt(before));
    expect(holds[0]!+holds[1]!).toBeGreaterThan(BigInt(before));
    let failure:unknown;
    try{
      await createOrReplayStoredBatch({
        orgId:f.org,apiKeyId:f.key,batchId:'batch_'+randomUUID().replaceAll('-',''),batchType:'chat',
        contractVersion:5,billingMode:'stored',idempotencyKeyDigest:'a'.repeat(64),requestFingerprint:'b'.repeat(64),
        expiresAt:new Date(Date.now()+86_400_000).toISOString(),items,
      });
    }catch(error){failure=error;}
    expect(failure).toMatchObject({code:'PAYMENT_REQUIRED',status:402});
    expect((await sql`SELECT id FROM batches WHERE org_id=${f.org}::uuid AND contract_version=5`)).toHaveLength(0);
    expect((await sql`SELECT id FROM batch_items WHERE billing_request_id=ANY(${billingIds}::uuid[])`)).toHaveLength(0);
    expect((await sql`SELECT billing_request_id FROM gateway_charge_admissions WHERE billing_request_id=ANY(${billingIds}::uuid[])`)).toHaveLength(0);
    expect((await sql`SELECT id FROM gateway_charge_admission_events WHERE admission_id=ANY(${billingIds}::uuid[])`)).toHaveLength(0);
    expect((await sql`SELECT billing_request_id FROM gateway_charge_quota_events WHERE billing_request_id=ANY(${billingIds}::uuid[])`)).toHaveLength(0);
    expect((await sql`SELECT billing_request_id FROM gateway_charge_quota_reservations WHERE billing_request_id=ANY(${billingIds}::uuid[])`)).toHaveLength(0);
    expect((await sql`SELECT billing_request_id FROM gateway_charge_quota_contexts WHERE billing_request_id=ANY(${billingIds}::uuid[])`)).toHaveLength(0);
    expect((await sql<{payg_credits:string}[]>`SELECT payg_credits::text FROM organizations WHERE id=${f.org}::uuid`)[0]!.payg_credits).toBe(before);
  },30000);

  it('serializes concurrent same-key creation, replays one owner and conflicts a changed fingerprint',async()=>{
    const f=await fixture(2_000_000n);
    const make=(offset:number)=>{
      let n=200+offset; const next=()=>uuid(n++);
      return [item(0,'a',f.org,f.key,next),item(1,'b',f.org,f.key,next)];
    };
    const common={
      orgId:f.org,apiKeyId:f.key,batchType:'chat' as const,contractVersion:5 as const,billingMode:'stored' as const,
      idempotencyKeyDigest:'c'.repeat(64),requestFingerprint:'d'.repeat(64),
      expiresAt:new Date(Date.now()+86_400_000).toISOString(),
    };
    const [left,right]=await Promise.all([
      createOrReplayStoredBatch({...common,batchId:'batch_'+randomUUID().replaceAll('-',''),items:make(0)}),
      createOrReplayStoredBatch({...common,batchId:'batch_'+randomUUID().replaceAll('-',''),items:make(20)}),
    ]);
    expect([left.kind,right.kind].sort()).toEqual(['created','replay']);
    expect(left.batch.batchId).toBe(right.batch.batchId);
    expect((await sql`SELECT id FROM batches WHERE org_id=${f.org}::uuid AND contract_version=5`)).toHaveLength(1);
    expect((await sql`SELECT bi.id FROM batch_items bi JOIN batches b ON b.id=bi.batch_id WHERE b.org_id=${f.org}::uuid AND b.contract_version=5`)).toHaveLength(2);
    expect((await sql`SELECT billing_request_id FROM gateway_charge_admissions WHERE org_id=${f.org}::uuid`)).toHaveLength(2);
    await expect(createOrReplayStoredBatch({
      ...common,batchId:'batch_'+randomUUID().replaceAll('-',''),requestFingerprint:'e'.repeat(64),items:make(40),
    })).rejects.toBeInstanceOf(StoredBatchConflictError);
  },30000);

  it('keeps summary/results reads org-scoped and worker claim single-owner without creating another admission',async()=>{
    const f=await fixture(2_000_000n);
    let n=300; const next=()=>uuid(n++);
    const batchId='batch_'+randomUUID().replaceAll('-','');
    const preparedItems=[item(0,'first',f.org,f.key,next),item(1,'second',f.org,f.key,next)];
    const created=await createOrReplayStoredBatch({
      orgId:f.org,apiKeyId:f.key,batchId,batchType:'chat',contractVersion:5,billingMode:'stored',
      idempotencyKeyDigest:'f'.repeat(64),requestFingerprint:'1'.repeat(64),
      expiresAt:new Date(Date.now()+86_400_000).toISOString(),items:preparedItems,
    });

    expect(await readStoredBatch(randomUUID(),batchId)).toBeNull();
    expect(await readStoredBatch(f.org,batchId)).toMatchObject({batchId,status:'queued',totalCount:2});
    expect(await hasQueuedStoredBatchItems(batchId)).toBe(true);
    await expect(readStoredBatchResults(randomUUID(),batchId)).resolves.toEqual({items:[],nextCursor:null});
    await expect(readStoredBatchResults(f.org,batchId,-1,1)).resolves.toMatchObject({
      items:[{index:0,customId:'first',status:'queued',output:null,errorCode:null,settledMicrocredits:null}],
      nextCursor:0,
    });
    await expect(readStoredBatchResults(f.org,batchId,0,1)).resolves.toMatchObject({
      items:[{index:1,customId:'second',status:'queued',output:null,errorCode:null,settledMicrocredits:null}],
      nextCursor:null,
    });

    const claims=await Promise.all([claimNextStoredBatchItem(batchId),claimNextStoredBatchItem(batchId)]);
    const claimed=claims.find((value)=>value!==null);
    expect(claims.filter((value)=>value!==null)).toHaveLength(1);
    expect(claimed).toMatchObject({
      parentId:created.batch.id,batchId,itemIndex:0,customId:'first',status:'processing',
      routeKind:'chat',providerRequest:preparedItems[0]!.execution.status==='ready'
        ? preparedItems[0]!.execution.providerRequest : null,
      admission:{state:'held',billingMode:'stored'},
    });
    await expect(loadStoredBatchItem(claimed!.id)).resolves.toMatchObject({id:claimed!.id,status:'processing'});
    expect(await hasQueuedStoredBatchItems(batchId)).toBe(true);
    expect(await hasQueuedStoredBatchItems('batch_'+randomUUID().replaceAll('-',''))).toBe(false);
    expect(await sql`SELECT billing_request_id FROM gateway_charge_admissions WHERE org_id=${f.org}::uuid`).toHaveLength(2);
  },30000);

  it('makes terminal completion exactly idempotent and refreshes aggregate from items plus settled admissions',async()=>{
    const f=await fixture(2_000_000n);
    let n=400; const next=()=>uuid(n++);
    const batchId='batch_'+randomUUID().replaceAll('-','');
    const created=await createOrReplayStoredBatch({
      orgId:f.org,apiKeyId:f.key,batchId,batchType:'chat',contractVersion:5,billingMode:'stored',
      idempotencyKeyDigest:'2'.repeat(64),requestFingerprint:'3'.repeat(64),
      expiresAt:new Date(Date.now()+86_400_000).toISOString(),items:[item(0,'terminal',f.org,f.key,next)],
    });
    await markStoredBatchQueueRecoveryNeeded(batchId,new Date(Date.now()+60_000).toISOString());
    const claimed=await claimNextStoredBatchItem(batchId);
    expect(claimed).not.toBeNull();
    const settlement=await sql<Array<{settled_at:string;actual_cost_credits:string}>>`
      UPDATE gateway_charge_admissions SET
        state='settled',attempt_id=${claimed!.attemptId}::uuid,upstream_id=${claimed!.upstreamId},
        pricing_snapshot=${JSON.stringify(claimed!.pricingSnapshot)}::text::jsonb,
        actual_cost_credits=authorized_max_credits,usage_snapshot='{}'::jsonb,outcome_kind='success',
        dispatched_at=created_at+interval '1 millisecond',outcome_recorded_at=created_at+interval '2 milliseconds',
        settled_at=created_at+interval '3 milliseconds',reconcile_after=NULL
      WHERE billing_request_id=${claimed!.billingRequestId}::uuid
      RETURNING to_char(settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS settled_at,
        actual_cost_credits::text`;
    const settledAt=settlement[0]!.settled_at;
    const actual=BigInt(settlement[0]!.actual_cost_credits);
    const resultDigest='4'.repeat(64);
    await markStoredBatchItemTerminal({
      itemId:claimed!.id,status:'completed',output:{a:'first',z:'last'},resultDigest,settledAt,
    });
    await expect(markStoredBatchItemTerminal({
      itemId:claimed!.id,status:'completed',output:{z:'last',a:'first'},resultDigest,settledAt,
    })).resolves.toBeUndefined();
    await expect(markStoredBatchItemTerminal({
      itemId:claimed!.id,status:'completed',output:{a:'first',z:'last'},resultDigest,
      settledAt:new Date(Date.parse(settledAt)+1000).toISOString(),
    })).rejects.toBeInstanceOf(StoredBatchConflictError);
    await expect(readStoredBatch(f.org,batchId)).resolves.toMatchObject({
      status:'completed',completedCount:1,reconciliationCount:0,
    });

    await sql`UPDATE batches SET total_count=99,completed_count=0,failed_count=99,status='failed' WHERE id=${created.batch.id}::uuid`;
    await refreshStoredBatchAggregate(created.batch.id);
    await expect(readStoredBatch(f.org,batchId)).resolves.toMatchObject({
      status:'completed',totalCount:1,completedCount:1,failedCount:0,reconciliationCount:0,
      settledMicrocredits:actual,reconcileAfter:null,
    });
    await expect(readStoredBatchResults(f.org,batchId)).resolves.toMatchObject({
      items:[{index:0,status:'completed',output:{a:'first',z:'last'},settledMicrocredits:actual}],
      nextCursor:null,
    });
  },30000);

  it('selects only due recoverable batches that still own runnable queued items',async()=>{
    const f=await fixture(2_000_000n);
    let n=500; const next=()=>uuid(n++);
    const batchId='batch_'+randomUUID().replaceAll('-','');
    await createOrReplayStoredBatch({
      orgId:f.org,apiKeyId:f.key,batchId,batchType:'chat',contractVersion:5,billingMode:'stored',
      idempotencyKeyDigest:'5'.repeat(64),requestFingerprint:'6'.repeat(64),
      expiresAt:new Date(Date.now()+86_400_000).toISOString(),items:[item(0,'recover',f.org,f.key,next)],
    });
    const now=new Date();
    const future=new Date(now.getTime()+60_000).toISOString();
    expect(await listRecoverableStoredBatches(new Date(now.getTime()+120_000).toISOString())).not.toContain(batchId);
    await markStoredBatchQueueRecoveryNeeded(batchId,future);
    expect(await listRecoverableStoredBatches(now.toISOString())).not.toContain(batchId);
    expect(await listRecoverableStoredBatches(new Date(now.getTime()+120_000).toISOString())).toContain(batchId);
    expect(await claimNextStoredBatchItem(batchId)).not.toBeNull();
    expect(await listRecoverableStoredBatches(new Date(now.getTime()+120_000).toISOString())).not.toContain(batchId);
  },30000);

  it('acks queue ownership once after worker progress and preserves the first ack across duplicate and terminal races',async()=>{
    const f=await fixture(2_000_000n);
    let n=600; const next=()=>uuid(n++);
    const batchId='batch_'+randomUUID().replaceAll('-','');
    await createOrReplayStoredBatch({
      orgId:f.org,apiKeyId:f.key,batchId,batchType:'chat',contractVersion:5,billingMode:'stored',
      idempotencyKeyDigest:'7'.repeat(64),requestFingerprint:'8'.repeat(64),
      expiresAt:new Date(Date.now()+86_400_000).toISOString(),items:[item(0,'queue-ack',f.org,f.key,next)],
    });
    const queuedAt='2026-09-27T19:00:00.123000Z';
    await markStoredBatchQueueRecoveryNeeded(batchId,'2026-09-27T19:05:00.000000Z');
    expect(await claimNextStoredBatchItem(batchId)).not.toBeNull();
    expect(await hasQueuedStoredBatchItems(batchId)).toBe(false);

    await expect(markStoredBatchQueued(batchId,queuedAt)).resolves.toBeUndefined();
    await expect(readStoredBatch(f.org,batchId)).resolves.toMatchObject({queuedAt,reconcileAfter:null,status:'processing'});
    await expect(markStoredBatchQueued(batchId,queuedAt)).resolves.toBeUndefined();
    await expect(markStoredBatchQueued(batchId,'2026-09-27T19:00:01.123000Z'))
      .resolves.toBeUndefined();
    await expect(readStoredBatch(f.org,batchId)).resolves.toMatchObject({queuedAt});
    await expect(markStoredBatchQueued('batch_'+randomUUID().replaceAll('-',''),queuedAt)).rejects.toThrow();
    const legacyBatchId='batch_'+randomUUID().replaceAll('-','');
    await sql`INSERT INTO batches(batch_id,org_id,api_key_id,type,status,input_file_url,expires_at)
      VALUES(${legacyBatchId},${f.org}::uuid,${f.key}::uuid,'chat','queued','inline:legacy',clock_timestamp()+interval '1 day')`;
    await expect(markStoredBatchQueued(legacyBatchId,queuedAt)).rejects.toBeInstanceOf(StoredBatchConflictError);

    await sql`UPDATE batches SET terminal_at=clock_timestamp() WHERE batch_id=${batchId}`;
    await expect(markStoredBatchQueued(batchId,'2026-09-27T19:00:02.123000Z')).resolves.toBeUndefined();
    await expect(readStoredBatch(f.org,batchId)).resolves.toMatchObject({queuedAt});

    const lateBatchId='batch_'+randomUUID().replaceAll('-','');
    await createOrReplayStoredBatch({
      orgId:f.org,apiKeyId:f.key,batchId:lateBatchId,batchType:'chat',contractVersion:5,billingMode:'stored',
      idempotencyKeyDigest:'9'.repeat(64),requestFingerprint:'a'.repeat(64),
      expiresAt:new Date(Date.now()+86_400_000).toISOString(),items:[item(0,'late-first-ack',f.org,f.key,next)],
    });
    await sql`UPDATE batches SET terminal_at=clock_timestamp() WHERE batch_id=${lateBatchId}`;
    await expect(markStoredBatchQueued(lateBatchId,queuedAt)).resolves.toBeUndefined();
    await expect(readStoredBatch(f.org,lateBatchId)).resolves.toMatchObject({queuedAt:null});
  },30000);

  it('persists exact pending evidence idempotently and selects outcome obligations even when evidence is missing',async()=>{
    const f=await fixture(2_000_000n);
    let n=700; const next=()=>uuid(n++);
    const createClaim=async(digest:string,customId:string)=>{
      const batchId='batch_'+randomUUID().replaceAll('-','');
      await createOrReplayStoredBatch({
        orgId:f.org,apiKeyId:f.key,batchId,batchType:'chat',contractVersion:5,billingMode:'stored',
        idempotencyKeyDigest:digest.repeat(64),requestFingerprint:(digest==='b'?'c':'d').repeat(64),
        expiresAt:new Date(Date.now()+86_400_000).toISOString(),items:[item(0,customId,f.org,f.key,next)],
      });
      const claimed=await claimNextStoredBatchItem(batchId);
      if(!claimed) throw new Error('claim missing');
      await sql`UPDATE gateway_charge_admissions SET state='dispatched',attempt_id=${claimed.attemptId}::uuid,
        upstream_id=${claimed.upstreamId},pricing_snapshot=${JSON.stringify(claimed.pricingSnapshot)}::text::jsonb,
        dispatched_at=clock_timestamp(),reconcile_after=clock_timestamp()+interval '15 minutes'
        WHERE billing_request_id=${claimed.billingRequestId}::uuid`;
      return claimed;
    };
    const owned=await createClaim('b','with-evidence');
    const output={answer:'ok'};
    const evidence={
      output,usageSnapshot:{version:1,promptTokens:1},actualCostCredits:1n,
      resultDigest:createHash('sha256').update(JSON.stringify(output)).digest('hex'),
    };
    await expect(recordStoredBatchPendingEvidence(owned.id,evidence)).resolves.toBeUndefined();
    await expect(recordStoredBatchPendingEvidence(owned.id,evidence)).resolves.toBeUndefined();
    await expect(recordStoredBatchPendingEvidence(owned.id,{...evidence,actualCostCredits:2n}))
      .rejects.toBeInstanceOf(StoredBatchConflictError);
    await expect(loadStoredBatchPendingEvidence(owned.id)).resolves.toEqual(evidence);
    const dispatchedCandidates=await listStoredBatchEvidenceRecoveryCandidates(new Date(Date.now()+60_000).toISOString());
    expect(dispatchedCandidates.find((value)=>value.itemId===owned.id)).toMatchObject({
      admissionState:'dispatched',evidence,
    });

    const missing=await createClaim('e','missing-evidence');
    await expect(loadStoredBatchPendingEvidence(missing.id)).resolves.toBeNull();
    for(const claimed of [owned,missing]){
      await sql`UPDATE gateway_charge_admissions SET state='outcome_recorded',actual_cost_credits=1,
        usage_snapshot=${JSON.stringify(evidence.usageSnapshot)}::text::jsonb,outcome_kind='success',
        outcome_recorded_at=clock_timestamp(),reconcile_after=clock_timestamp()
        WHERE billing_request_id=${claimed.billingRequestId}::uuid`;
    }
    const candidates=await listStoredBatchEvidenceRecoveryCandidates(new Date(Date.now()+60_000).toISOString());
    expect(candidates.find((value)=>value.itemId===owned.id)).toMatchObject({
      admissionState:'outcome_recorded',evidence,
    });
    expect(candidates.find((value)=>value.itemId===missing.id)).toMatchObject({
      admissionState:'outcome_recorded',evidence:null,
    });

    const settledRows=await sql<Array<{billing_request_id:string;settled_at:string}>>`
      UPDATE gateway_charge_admissions SET state='settled',settled_at=clock_timestamp(),reconcile_after=NULL
      WHERE billing_request_id=ANY(${[owned.billingRequestId,missing.billingRequestId]}::uuid[])
      RETURNING billing_request_id::text,
        to_char(settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS settled_at`;
    await sql`UPDATE batch_items SET status='reconciliation_required',error_code='OUTCOME_ACK_LOST'
      WHERE id=ANY(${[owned.id,missing.id]}::uuid[])`;
    const ownedSettled=settledRows.find((value)=>value.billing_request_id===owned.billingRequestId)!.settled_at;
    const missingSettled=settledRows.find((value)=>value.billing_request_id===missing.billingRequestId)!.settled_at;
    await expect(completeStoredBatchItemFromPendingEvidence(owned.id,ownedSettled)).resolves.toBeUndefined();
    await expect(completeStoredBatchItemFromPendingEvidence(owned.id,ownedSettled)).resolves.toBeUndefined();
    await expect(readStoredBatchResults(f.org,owned.batchId)).resolves.toMatchObject({
      items:[{status:'completed',output}],
    });
    await expect(sql`SELECT result_digest FROM batch_items WHERE id=${owned.id}::uuid`)
      .resolves.toEqual([{result_digest:evidence.resultDigest}]);
    await sql`UPDATE batch_items SET output='{"answer":"tampered"}'::jsonb WHERE id=${owned.id}::uuid`;
    await expect(completeStoredBatchItemFromPendingEvidence(owned.id,ownedSettled))
      .rejects.toBeInstanceOf(StoredBatchConflictError);
    await expect(completeStoredBatchItemFromPendingEvidence(missing.id,missingSettled))
      .rejects.toBeInstanceOf(StoredBatchConflictError);
  },30000);

  it('releases only held undispatched processing claims and marks the parent for retry',async()=>{
    const f=await fixture(2_000_000n);
    let n=800; const next=()=>uuid(n++);
    const batchId='batch_'+randomUUID().replaceAll('-','');
    await createOrReplayStoredBatch({
      orgId:f.org,apiKeyId:f.key,batchId,batchType:'chat',contractVersion:5,billingMode:'stored',
      idempotencyKeyDigest:'f'.repeat(64),requestFingerprint:'0'.repeat(64),
      expiresAt:new Date(Date.now()+86_400_000).toISOString(),items:[item(0,'retry',f.org,f.key,next)],
    });
    const claimed=await claimNextStoredBatchItem(batchId);
    if(!claimed) throw new Error('claim missing');
    const retryAt='2030-01-01T00:01:00.000000Z';
    await expect(releaseStoredBatchItemClaimForRetry(claimed.id,retryAt)).resolves.toBeUndefined();
    await expect(loadStoredBatchItem(claimed.id)).resolves.toMatchObject({status:'queued',admission:{state:'held'}});
    await expect(readStoredBatch(f.org,batchId)).resolves.toMatchObject({status:'reconciliation_required',reconcileAfter:retryAt});
    await expect(releaseStoredBatchItemClaimForRetry(claimed.id,retryAt)).rejects.toBeInstanceOf(StoredBatchConflictError);
  },30000);

  it('requeues stale held claims but reconciles stale dispatched claims without provider work or releasing holds',async()=>{
    const f=await fixture(2_000_000n);
    let n=900; const next=()=>uuid(n++);
    const batchId='batch_'+randomUUID().replaceAll('-','');
    await createOrReplayStoredBatch({
      orgId:f.org,apiKeyId:f.key,batchId,batchType:'chat',contractVersion:5,billingMode:'stored',
      idempotencyKeyDigest:'1'.repeat(64),requestFingerprint:'2'.repeat(64),
      expiresAt:new Date(Date.now()+86_400_000).toISOString(),items:[item(0,'stale',f.org,f.key,next)],
    });
    const claimed=await claimNextStoredBatchItem(batchId);
    if(!claimed) throw new Error('claim missing');
    const now='2026-09-27T22:00:00.000000Z';
    await sql`UPDATE batch_items SET updated_at=${'2026-09-27T20:00:00.000000Z'}::timestamptz WHERE id=${claimed.id}::uuid`;
    await expect(reconcileStaleStoredBatchProcessing(now,3600,10)).resolves.toEqual([claimed.id]);
    await expect(loadStoredBatchItem(claimed.id)).resolves.toMatchObject({status:'queued',admission:{state:'held'}});
    await expect(readStoredBatch(f.org,batchId)).resolves.toMatchObject({status:'reconciliation_required',reconciliationCount:0});
    await expect(listRecoverableStoredBatches(now)).resolves.toContain(batchId);

    const dispatchedBatchId='batch_'+randomUUID().replaceAll('-','');
    await createOrReplayStoredBatch({
      orgId:f.org,apiKeyId:f.key,batchId:dispatchedBatchId,batchType:'chat',contractVersion:5,billingMode:'stored',
      idempotencyKeyDigest:'3'.repeat(64),requestFingerprint:'4'.repeat(64),
      expiresAt:new Date(Date.now()+86_400_000).toISOString(),items:[
        item(0,'dispatched-stale',f.org,f.key,next),item(1,'queued-sibling',f.org,f.key,next),
      ],
    });
    await markStoredBatchQueued(dispatchedBatchId,'2026-09-27T20:00:01.000000Z');
    const dispatched=await claimNextStoredBatchItem(dispatchedBatchId);
    if(!dispatched) throw new Error('dispatched claim missing');
    await sql`UPDATE gateway_charge_admissions SET state='dispatched',attempt_id=${dispatched.attemptId}::uuid,
      upstream_id=${dispatched.upstreamId},pricing_snapshot=${JSON.stringify(dispatched.pricingSnapshot)}::text::jsonb,
      dispatched_at=clock_timestamp(),reconcile_after=clock_timestamp()+interval '15 minutes'
      WHERE billing_request_id=${dispatched.billingRequestId}::uuid`;
    await sql`UPDATE batch_items SET updated_at=${'2026-09-27T20:00:00.000000Z'}::timestamptz WHERE id=${dispatched.id}::uuid`;
    await expect(reconcileStaleStoredBatchProcessing(now,3600,10)).resolves.toEqual([dispatched.id]);
    await expect(loadStoredBatchItem(dispatched.id)).resolves.toMatchObject({
      status:'reconciliation_required',admission:{state:'dispatched'},
    });
    await expect(readStoredBatch(f.org,dispatchedBatchId)).resolves.toMatchObject({status:'reconciliation_required',reconciliationCount:1});
    await expect(listRecoverableStoredBatches(now)).resolves.toContain(dispatchedBatchId);
    await expect(reconcileStaleStoredBatchProcessing(now,3600,10)).resolves.toEqual([]);
  },30000);
});
