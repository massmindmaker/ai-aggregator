/**
 * Canonical BullMQ queue names. Imported by both producers (gateway) and
 * consumers (this worker) so a typo in either breaks compile-time.
 */
export const QUEUE_NAMES = {
  upstreamPoll: 'upstream-poll',
  contestEval: 'contest-eval',
  webhookRetry: 'webhook-retry',
  emailSend: 'email-send',
  batchProcess: 'batch-process',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
