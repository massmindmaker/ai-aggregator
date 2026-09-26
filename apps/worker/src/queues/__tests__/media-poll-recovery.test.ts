import { describe,expect,it,vi } from 'vitest';
import { recoverOwnedMediaPollsOnce } from '../media-poll-recovery';

describe('media poll recovery',()=>{
  it('enqueues only DB-owned jobs missing from waiting/active/delayed queue state',async()=>{
    const db={scanRecoverable:vi.fn().mockResolvedValue(['j1','j2'])};
    const queue={
      getJobs:vi.fn().mockResolvedValue([{data:{jobId:'j1'}},{data:{other:true}}]),
      add:vi.fn().mockResolvedValue(undefined),
    };
    const result=await recoverOwnedMediaPollsOnce(db,queue as never,10);
    expect(result).toEqual({selected:2,enqueued:1,alreadyQueued:1});
    expect(db.scanRecoverable).toHaveBeenCalledWith(10);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0]![0]).toBe('poll');
    expect(queue.add.mock.calls[0]![1]).toEqual({jobId:'j2'});
    expect(String(queue.add.mock.calls[0]![2]?.jobId)).not.toContain(':');
    expect(JSON.stringify(queue.add.mock.calls[0]![1])).not.toContain('provider');
  });

  it('does no queue scan when DB has no recoverable jobs',async()=>{
    const db={scanRecoverable:vi.fn().mockResolvedValue([])};
    const queue={getJobs:vi.fn(),add:vi.fn()};
    expect(await recoverOwnedMediaPollsOnce(db,queue as never)).toEqual({selected:0,enqueued:0,alreadyQueued:0});
    expect(queue.getJobs).not.toHaveBeenCalled();
  });
});
