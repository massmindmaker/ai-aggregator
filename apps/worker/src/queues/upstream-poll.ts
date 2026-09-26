import { Worker, type Job, type Processor } from 'bullmq';
import type IORedis from 'ioredis';
import { logger } from '../logger.js';
import { QUEUE_NAMES } from './names.js';
import type { OwnedMediaJob } from './upstream-poll-db.js';

export interface UpstreamPollJobData { jobId:string }
export interface UpstreamPollResult { status:'completed'|'failed'|'pending'; output?:unknown; error?:string }
export interface UpstreamPollDeps {
 load:(jobId:string)=>Promise<OwnedMediaJob|null>;
 markProcessing:(jobId:string)=>Promise<void>;
 poll:(job:OwnedMediaJob)=>Promise<UpstreamPollResult>;
 finalize:(job:OwnedMediaJob,status:'completed'|'failed',output:unknown,errorMessage?:string)=>Promise<void>;
}
export function buildUpstreamPollProcessor(deps:UpstreamPollDeps):Processor<UpstreamPollJobData,UpstreamPollResult,string>{
 return async(job:Job<UpstreamPollJobData>)=>{
  const owned=await deps.load(job.data.jobId);if(!owned)throw new Error('MEDIA_JOB_NOT_FOUND');
  if(owned.status==='completed'||owned.status==='failed'){await deps.finalize(owned,owned.status,owned.output,owned.errorMessage??undefined);return {status:owned.status,output:owned.output};}
  if(!owned.providerTaskId)throw new Error('MEDIA_PROVIDER_TASK_NOT_ATTACHED');
  if(Date.now()>owned.deadlineAt){await deps.finalize(owned,'failed',{error:{code:'MEDIA_DEADLINE_EXCEEDED'}},'deadline_exceeded');return {status:'failed',error:'deadline_exceeded'};}
  await deps.markProcessing(owned.id);
  const result=await deps.poll(owned);
  if(result.status==='pending'){
   const delay=Math.min(30_000,5000*Math.max(1,job.attemptsMade+1));
   await (job as unknown as {queue?:{add:(name:string,data:unknown,opts:unknown)=>Promise<unknown>}}).queue?.add(job.name,{jobId:owned.id},{delay,jobId:'media:'+owned.id+':'+Date.now()});
   return result;
  }
  await deps.finalize(owned,result.status,result.output??{},result.error);
  logger.info({jobId:owned.id,status:result.status},'upstream-poll: terminal');
  return result;
 };
}
export function startUpstreamPollWorker(connection:IORedis,deps:UpstreamPollDeps){return new Worker(QUEUE_NAMES.upstreamPoll,buildUpstreamPollProcessor(deps),{connection,concurrency:8});}
