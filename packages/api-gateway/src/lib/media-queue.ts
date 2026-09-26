import { config } from '../config';
export const MEDIA_POLL_QUEUE_NAME='upstream-poll';
export async function enqueueOwnedMediaPoll(jobId:string):Promise<void>{
 const {Queue}=await import('bullmq'); const url=new URL(config.REDIS_URL);
 const q=new Queue(MEDIA_POLL_QUEUE_NAME,{connection:{host:url.hostname,port:Number(url.port)||6379,password:url.password||undefined,tls:url.protocol==='rediss:'?{}:undefined}});
 try{await q.add('poll',{jobId},{jobId:'media-'+jobId,removeOnComplete:1000,removeOnFail:1000});}finally{await q.close();}
}
