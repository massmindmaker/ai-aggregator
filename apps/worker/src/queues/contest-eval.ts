import { Worker, type Job, type Processor } from 'bullmq';
import type IORedis from 'ioredis';
import { logger } from '../logger.js';
import { QUEUE_NAMES } from './names.js';
import type { EvalRunResult, SubmissionFileRef } from '../eval-runner/runner.js';

/**
 * Job payload for contest-eval queue. The web/admin enqueues this when a
 * submission is accepted and a script-based evaluator is configured.
 */
export interface ContestEvalJobData {
  submissionId: string;
  evaluatorScriptId: string;
  /** S3 key (or local path in dev) of the python script to run */
  scriptSource: string;
  /** Submission files (name + S3/public URL) to download into the eval workdir */
  submissionFiles: SubmissionFileRef[];
  inputJson: unknown;
  timeoutMs?: number;
}

export type ContestEvalRunner = (opts: {
  evaluatorScript: string;
  submissionFiles: SubmissionFileRef[];
  inputJson: unknown;
  timeoutMs?: number;
}) => Promise<EvalRunResult>;

export type ContestEvalSink = (input: {
  submissionId: string;
  evaluatorScriptId: string;
  status: 'success' | 'failed' | 'timeout' | 'invalid';
  publicScore?: number;
  stdout?: string;
  stderr?: string;
}) => Promise<void>;

export interface ContestEvalDeps {
  run: ContestEvalRunner;
  sink: ContestEvalSink;
}

export function buildContestEvalProcessor(
  deps: ContestEvalDeps
): Processor<ContestEvalJobData, EvalRunResult, string> {
  return async (job: Job<ContestEvalJobData>) => {
    const { submissionId, evaluatorScriptId, scriptSource, submissionFiles, inputJson, timeoutMs } =
      job.data;

    const result = await deps.run({
      evaluatorScript: scriptSource,
      submissionFiles,
      inputJson,
      timeoutMs,
    });

    let status: 'success' | 'failed' | 'timeout' | 'invalid';
    if (result.ok) status = 'success';
    else if (result.error === 'timeout') status = 'timeout';
    else if (result.error === 'Invalid JSON output') status = 'invalid';
    else status = 'failed';

    await deps.sink({
      submissionId,
      evaluatorScriptId,
      status,
      publicScore: result.score,
      stdout: result.output,
      stderr: result.error,
    });

    logger.info({ submissionId, status }, 'contest-eval: completed');
    return result;
  };
}

export function startContestEvalWorker(
  connection: IORedis,
  deps: ContestEvalDeps
): Worker<ContestEvalJobData, EvalRunResult> {
  return new Worker<ContestEvalJobData, EvalRunResult>(
    QUEUE_NAMES.contestEval,
    buildContestEvalProcessor(deps),
    { connection, concurrency: 2 }
  );
}
