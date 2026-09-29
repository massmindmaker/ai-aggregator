import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({events:[] as string[],handlers:new Map<string,()=>void>(),failRedis:false,
 tonStart:vi.fn(),tonClose:vi.fn(),gatewayClose:vi.fn(),queueClose:vi.fn(),mediaClose:vi.fn(),quit:vi.fn(),info:vi.fn(),fatal:vi.fn(),error:vi.fn(),exit:vi.fn()}));
vi.mock('../env.js',()=>({loadSharedEnv:()=>m.events.push('env')}));
vi.mock('../logger.js',()=>({logger:{info:m.info,fatal:m.fatal,error:m.error,warn:vi.fn()}}));
vi.mock('../ton-payment-bootstrap.js',()=>({
 startTonReconciliationFromEnv:(options:unknown)=>{m.events.push('ton');return m.tonStart(options);},
 TonReconciliationStartupError:class TonReconciliationStartupError extends Error {constructor(){super('TON_RECONCILIATION_STARTUP_REFUSED');}}
}));
vi.mock('../gateway-settlement-recovery-bootstrap.js',()=>({startGatewaySettlementRecoveryFromEnv:async()=>{m.events.push('gateway');return {close:m.gatewayClose};},logGatewaySettlementRecoveryBoundaryFailure:()=>false}));
vi.mock('../redis.js',()=>({createRedisConnection:()=>{m.events.push('redis');if(m.failRedis)throw Error('synthetic downstream startup failure');return {quit:m.quit,ping:async()=>'PONG'};}}));
vi.mock('../queues/upstream-poll.js',()=>({startUpstreamPollWorker:()=>({close:m.queueClose})}));
vi.mock('../queues/upstream-poll-db.js',()=>({MediaJobDb:class {close=m.mediaClose;}}));
vi.mock('../queues/media-poll-recovery.js',()=>({startMediaPollRecovery:()=>({close:m.queueClose})}));
vi.mock('../media-kie.js',()=>({createMediaKieAdapter:()=>null}));
vi.mock('../queues/contest-eval.js',()=>({startContestEvalWorker:()=>({close:m.queueClose})}));
vi.mock('../queues/webhook-retry.js',()=>({startWebhookRetryWorker:()=>({close:m.queueClose})}));
vi.mock('../queues/email-send.js',()=>({startEmailSendWorker:()=>({close:m.queueClose})}));
vi.mock('../queues/close-contests-cron.js',()=>({startCloseContestsCron:()=>({close:m.queueClose})}));
vi.mock('../queues/finalize-earnings-cron.js',()=>({startFinalizeEarningsCron:()=>({close:m.queueClose})}));
vi.mock('../eval-runner/runner.js',()=>({runEvaluation:vi.fn()}));
vi.mock('../probes/internal-probe.js',()=>({startInternalProbe:()=>({stop:vi.fn()})}));
vi.mock('../catalog/sync-cron.js',()=>({startCatalogSyncCron:vi.fn()}));
vi.mock('../queues/batch-process.js',()=>({startBatchProcessWorker:()=>({close:m.queueClose})}));
vi.mock('../queues/batch-process-recovery.js',()=>({startBatchProcessRecovery:()=>({close:m.queueClose})}));
vi.mock('node:http',()=>({createServer:()=>({listen:(_port:unknown,_host:unknown,ready:()=>void)=>ready(),close:vi.fn()})}));
import {TonReconciliationStartupError} from '../ton-payment-bootstrap.js';
async function boot(){await import('../index');await vi.waitFor(()=>expect(m.info.mock.calls.some(call=>call.includes('aiag-worker started'))||m.exit.mock.calls.length>0).toBe(true));}
beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();m.events=[];m.handlers.clear();m.failRedis=false;
 m.tonClose.mockResolvedValue({kind:'closed',mutationOutcome:'known'});m.tonStart.mockResolvedValue({close:m.tonClose});
 m.gatewayClose.mockResolvedValue(undefined);m.queueClose.mockResolvedValue(undefined);m.mediaClose.mockResolvedValue(undefined);m.quit.mockResolvedValue('OK');
 vi.spyOn(process,'exit').mockImplementation(m.exit as never);
 vi.spyOn(process,'on').mockImplementation(((signal:string,handler:()=>void)=>{m.handlers.set(signal,handler);return process;}) as typeof process.on);
});
afterEach(()=>vi.restoreAllMocks());
describe('shared worker TON observation wiring without external resources',()=>{
 it('loads env first, invokes TON exactly once and preserves existing gateway/Redis initialization',async()=>{await boot();expect(m.events.slice(0,2)).toEqual(['env','ton']);expect(m.tonStart).toHaveBeenCalledTimes(1);expect(m.events).toContain('gateway');expect(m.events).toContain('redis');m.handlers.get('SIGTERM')!();await vi.waitFor(()=>expect(m.exit).toHaveBeenCalledWith(0));expect(m.tonClose).toHaveBeenCalledTimes(1);});
 it('fails closed and logs a bounded code if TON startup is refused',async()=>{m.tonStart.mockRejectedValueOnce(new TonReconciliationStartupError());await boot();expect(m.exit).toHaveBeenCalledWith(1);expect(m.events).not.toContain('redis');expect(m.fatal).toHaveBeenCalledWith({component:'ton-reconciliation',classification:'startup_refused'},'TON reconciliation startup refused');});
 it('closes the TON handle when an unrelated later startup phase fails',async()=>{m.failRedis=true;await boot();expect(m.tonClose).toHaveBeenCalledTimes(1);expect(m.exit).toHaveBeenCalledWith(1);});
 it('deduplicates overlapping SIGTERM/SIGINT and closes legacy workers too',async()=>{await boot();m.handlers.get('SIGTERM')!();m.handlers.get('SIGINT')!();await vi.waitFor(()=>expect(m.exit).toHaveBeenCalledTimes(1));expect(m.tonClose).toHaveBeenCalledTimes(1);expect(m.gatewayClose).toHaveBeenCalledTimes(1);expect(m.quit).toHaveBeenCalledTimes(1);});
 it.each([{kind:'closed',mutationOutcome:'unknown'},{kind:'deadline_exceeded',phase:'pool',mutationOutcome:'known'}])('reports exact non-clean TON close and does not exit successfully: %j',async result=>{m.tonClose.mockResolvedValueOnce(result);await boot();m.handlers.get('SIGTERM')!();await vi.waitFor(()=>expect(m.exit).toHaveBeenCalledWith(1));expect(m.info).toHaveBeenCalledWith({component:'ton-reconciliation',result},'TON reconciliation closed');expect(m.quit).toHaveBeenCalledTimes(1);});
 it('still awaits TON and Redis cleanup when a legacy worker close rejects',async()=>{m.queueClose.mockRejectedValueOnce(Error('synthetic close failure'));await boot();m.handlers.get('SIGTERM')!();await vi.waitFor(()=>expect(m.exit).toHaveBeenCalledWith(1));expect(m.tonClose).toHaveBeenCalledTimes(1);expect(m.mediaClose).toHaveBeenCalledTimes(1);expect(m.quit).toHaveBeenCalledTimes(1);});
});
