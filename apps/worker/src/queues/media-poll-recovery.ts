import { Queue, type JobsOptions } from 'bullmq';
import type IORedis from 'ioredis';
import { logger } from '../logger.js';
import { QUEUE_NAMES } from './names.js';

export type MediaRecoveryDb = Readonly<{
  scanRecoverable(limit?: number): Promise<readonly string[]>;
}>;

type QueueLike = Readonly<{
  getJobs(types: Array<'waiting'|'active'|'delayed'>, start?: number, end?: number, asc?: boolean): Promise<Array<Readonly<{ data?: unknown }>>>;
  add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
}>;

function jobIdFromData(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).jobId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export async function recoverOwnedMediaPollsOnce(
  db: MediaRecoveryDb,
  queue: QueueLike,
  limit = 100,
): Promise<Readonly<{ selected:number; enqueued:number; alreadyQueued:number }>> {
  const ids = await db.scanRecoverable(limit);
  if (ids.length === 0) return Object.freeze({ selected:0, enqueued:0, alreadyQueued:0 });
  const live = new Set(
    (await queue.getJobs(['waiting','active','delayed'],0,4999,true))
      .map((job)=>jobIdFromData(job.data))
      .filter((id): id is string => id !== null),
  );
  let enqueued=0, alreadyQueued=0;
  for (const jobId of ids) {
    if (live.has(jobId)) { alreadyQueued += 1; continue; }
    await queue.add('poll',{jobId},{
      jobId:`media-recovery-${jobId}-${Date.now()}`,
      removeOnComplete:1000,
      removeOnFail:1000,
    });
    live.add(jobId);
    enqueued += 1;
  }
  return Object.freeze({selected:ids.length,enqueued,alreadyQueued});
}

export function startMediaPollRecovery(
  connection: IORedis,
  db: MediaRecoveryDb,
  intervalMs = 30_000,
): Readonly<{ close():Promise<void> }> {
  const queue = new Queue(QUEUE_NAMES.upstreamPoll,{connection});
  let stopped=false, running:Promise<void>|null=null;
  const tick=()=>{
    if(stopped||running) return;
    running=recoverOwnedMediaPollsOnce(db,queue)
      .then((result)=>{ if(result.enqueued>0) logger.info(result,'media-poll recovery enqueued'); })
      .catch((error)=>logger.error({error:error instanceof Error?error.message:String(error)},'media-poll recovery failed'))
      .finally(()=>{running=null;});
  };
  tick();
  const timer=setInterval(tick,intervalMs); timer.unref?.();
  return Object.freeze({
    async close(){
      stopped=true; clearInterval(timer);
      if(running) await running;
      await queue.close();
    },
  });
}
