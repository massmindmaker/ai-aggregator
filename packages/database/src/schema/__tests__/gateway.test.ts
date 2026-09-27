import { describe, it, expect } from 'vitest';
import {
  upstreams,
  gatewayModels,
  modelUpstreams,
  gatewayApiKeys,
  gatewayRequests,
  gatewayTransactions,
  piiDetections,
  predictionJobs,
  batches,
  batchItems,
} from '../gateway';

describe('Plan 04 gateway schema', () => {
  it('upstreams has ru_residency + enabled + metrics', () => {
    const keys = Object.keys(upstreams);
    expect(keys).toEqual(
      expect.arrayContaining(['id', 'provider', 'ruResidency', 'enabled', 'latencyP50Ms', 'uptime'])
    );
  });

  it('models (gateway) has slug + type + enabled', () => {
    const keys = Object.keys(gatewayModels);
    expect(keys).toEqual(expect.arrayContaining(['slug', 'type', 'enabled']));
  });

  it('model_upstreams has per-upstream markup (FIX C8)', () => {
    const keys = Object.keys(modelUpstreams);
    expect(keys).toContain('markup');
    expect(keys).toContain('pricePer1kInput');
    expect(keys).toContain('pricePer1kOutput');
    expect(keys).toContain('upstreamModelId');
  });

  it('gateway_api_keys exposes policies jsonb + sha-256 hash + rpm/daily caps', () => {
    const keys = Object.keys(gatewayApiKeys);
    expect(keys).toContain('policies');
    expect(keys).toContain('keyHash');
    expect(keys).toContain('keyPrefix');
    expect(keys).toContain('rpmLimit');
    expect(keys).toContain('dailyUsdCap');
    expect(keys).toContain('batchRpmLimit');
  });

  it('requests partitioned columns present (input/output/cached tokens, portions, byok)', () => {
    const keys = Object.keys(gatewayRequests);
    expect(keys).toEqual(
      expect.arrayContaining([
        'requestId',
        'orgId',
        'inputTokens',
        'outputTokens',
        'cachedInputTokens',
        'totalCostRub',
        'subPortionRub',
        'paygPortionRub',
        'byok',
      ])
    );
  });

  it('gateway_transactions has delta/source/type/metadata', () => {
    const keys = Object.keys(gatewayTransactions);
    expect(keys).toEqual(
      expect.arrayContaining(['orgId', 'requestId', 'type', 'source', 'delta', 'metadata'])
    );
  });

  it('pii_detections uses sha-256 sample_hash (not raw text)', () => {
    const keys = Object.keys(piiDetections);
    expect(keys).toContain('sampleHash');
    expect(keys).not.toContain('sampleText');
    expect(keys).toContain('action');
  });

  it('prediction_jobs has task_id + status + upstream_task_id', () => {
    const keys = Object.keys(predictionJobs);
    expect(keys).toEqual(
      expect.arrayContaining(['taskId', 'status', 'upstreamTaskId', 'input', 'output', 'costRub'])
    );
  });

  it('batches has durable identity, queue recovery and terminal metadata', () => {
    const keys = Object.keys(batches);
    expect(keys).toEqual(expect.arrayContaining([
      'batchId', 'inputFileUrl', 'totalCount', 'completedCount', 'failedCount', 'costRub',
      'contractVersion', 'billingMode', 'idempotencyKeyDigest', 'requestFingerprint',
      'queuedAt', 'reconcileAfter', 'terminalAt',
    ]));
  });

  it('batch_items owns immutable item identity, billing owner, pinned execution facts and sanitized terminal result', () => {
    const keys = Object.keys(batchItems);
    expect(keys).toEqual(expect.arrayContaining([
      'batchId', 'itemIndex', 'customId', 'routeKind', 'requestFingerprint', 'requestBody',
      'billingRequestId', 'attemptId', 'modelSlug', 'modelUpstreamId', 'upstreamId',
      'upstreamModelId', 'adapterKey', 'pricingSnapshot', 'providerRequest', 'pendingEvidence',
      'status', 'output', 'errorCode', 'resultDigest',
      'deadlineAt', 'settledAt', 'createdAt', 'updatedAt',
    ]));
    expect(keys).not.toEqual(expect.arrayContaining(['apiKey', 'byokKey', 'proxyCredential', 'providerResponse']));
  });
});
