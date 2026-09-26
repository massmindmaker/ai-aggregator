import { createHash } from 'node:crypto';
import { Pool } from 'pg';

export type OwnedMediaJob = Readonly<{
 id:string; orgId:string; billingRequestId:string; status:'claimed'|'queued'|'processing'|'completed'|'failed';
 providerFamily:'image'|'video'|'suno'; providerTaskId:string|null; deadlineAt:number;
 quotedRetailMicrocredits:bigint; output:unknown; errorMessage:string|null; settledAt:string|null;
}>;
function digest(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export class MediaJobDb {
 private readonly pool:Pool;
 constructor(databaseUrl:string){this.pool=new Pool({connectionString:databaseUrl,max:4});}
 async close(){await this.pool.end();}
 async load(id:string):Promise<OwnedMediaJob|null>{
  const r=await this.pool.query("SELECT id::text,org_id::text,billing_request_id::text,status,provider_family,provider_task_id,extract(epoch from deadline_at)*1000 deadline_ms,quoted_retail_microcredits::text,output,error_message,settled_at::text FROM prediction_jobs WHERE id=$1::uuid AND contract_version=4",[id]);
  if(!r.rowCount)return null;const x=r.rows[0];
  return {id:x.id,orgId:x.org_id,billingRequestId:x.billing_request_id,status:x.status,providerFamily:x.provider_family,providerTaskId:x.provider_task_id,deadlineAt:Number(x.deadline_ms),quotedRetailMicrocredits:BigInt(x.quoted_retail_microcredits),output:x.output,errorMessage:x.error_message,settledAt:x.settled_at};
 }
 async markProcessing(id:string){await this.pool.query("UPDATE prediction_jobs SET status='processing' WHERE id=$1::uuid AND contract_version=4 AND status='queued'",[id]);}
 async scanRecoverable(limit=100):Promise<readonly string[]>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new RangeError('invalid media recovery limit');
  const r=await this.pool.query(
   "SELECT p.id::text FROM prediction_jobs p JOIN gateway_charge_admissions a ON a.billing_request_id=p.billing_request_id WHERE p.contract_version=4 AND p.provider_task_id IS NOT NULL AND p.settled_at IS NULL AND (p.status IN ('queued','processing') OR (p.status IN ('completed','failed') AND a.state IN ('outcome_recorded','settled'))) ORDER BY p.created_at,p.id LIMIT $1",
   [limit],
  );
  return Object.freeze(r.rows.map((row)=>String(row.id)));
 }
 async finalize(job:OwnedMediaJob,status:'completed'|'failed',output:unknown,_errorMessage?:string):Promise<void>{
  let orgId='',billingRequestId='';
  const client=await this.pool.connect();
  try{
   await client.query('BEGIN');
   const locked=await client.query("SELECT p.*,a.attempt_id::text,a.upstream_id,a.state admission_state FROM prediction_jobs p JOIN gateway_charge_admissions a ON a.billing_request_id=p.billing_request_id WHERE p.id=$1::uuid AND p.contract_version=4 FOR UPDATE OF p,a",[job.id]);
   if(!locked.rowCount)throw new Error('MEDIA_JOB_NOT_FOUND');
   const x=locked.rows[0]; orgId=String(x.org_id); billingRequestId=String(x.billing_request_id);
   if(x.settled_at){await client.query('COMMIT');return;}
   if(x.admission_state==='settled'){
    if(x.status!=='completed'&&x.status!=='failed')throw new Error('MEDIA_TERMINAL_STATE_CONFLICT');
    await client.query('COMMIT');
   }else if(x.admission_state==='outcome_recorded'){
    if(x.status!=='completed'&&x.status!=='failed')throw new Error('MEDIA_TERMINAL_STATE_CONFLICT');
    await client.query('COMMIT');
   }else if(x.admission_state==='dispatched'){
    const safeOutput=status==='completed'?output:{error:{code:'MEDIA_JOB_FAILED',message:'Media job failed'}};
    await client.query("UPDATE prediction_jobs SET status=$2,output=$3::jsonb,error_message=$4,completed_at=coalesce(completed_at,clock_timestamp()),result_digest=$5 WHERE id=$1::uuid",[job.id,status,JSON.stringify(safeOutput),status==='failed'?'MEDIA_JOB_FAILED':null,digest(safeOutput)]);
    const actual=status==='completed'?BigInt(x.quoted_retail_microcredits):0n;
    const usage={version:1,formulaVersion:'media-unit-microcredits-v1',billingRequestId:x.billing_request_id,attemptId:x.attempt_id,upstreamId:x.upstream_id,terminalStatus:status,verified:true};
    await client.query("SELECT * FROM aiag_record_gateway_charge_outcome_v2($1::uuid,$2::uuid,$3::bigint,$4::jsonb,'success')",[x.org_id,x.billing_request_id,actual.toString(),JSON.stringify(usage)]);
    await client.query('COMMIT');
   }else{
    throw new Error('MEDIA_OUTCOME_STATE_CONFLICT');
   }
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}

  const before=await this.pool.query('SELECT state FROM gateway_charge_admissions WHERE billing_request_id=$1::uuid',[billingRequestId]);
  if(before.rows[0]?.state==='outcome_recorded'){
   await this.pool.query('SELECT * FROM aiag_settle_admitted_gateway_charge($1::uuid,$2::uuid)',[orgId,billingRequestId]);
  }
  const final=await this.pool.query('SELECT state FROM gateway_charge_admissions WHERE billing_request_id=$1::uuid',[billingRequestId]);
  if(final.rows[0]?.state!=='settled')throw new Error('MEDIA_SETTLEMENT_UNCONFIRMED');
  await this.pool.query('UPDATE prediction_jobs SET settled_at=coalesce(settled_at,clock_timestamp()) WHERE id=$1::uuid AND contract_version=4',[job.id]);
 }
}
