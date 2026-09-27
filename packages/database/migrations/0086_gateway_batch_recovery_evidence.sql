-- 0086_gateway_batch_recovery_evidence.sql
-- Sanitized post-provider evidence and bounded stale-processing recovery.

BEGIN;

ALTER TABLE batch_items
  ADD COLUMN pending_evidence JSONB,
  ADD CONSTRAINT batch_items_pending_evidence_check CHECK (
    pending_evidence IS NULL OR (
      jsonb_typeof(pending_evidence) = 'object'
      AND pending_evidence ?& ARRAY['output','usageSnapshot','actualCostCredits','resultDigest']
      AND pending_evidence - ARRAY['output','usageSnapshot','actualCostCredits','resultDigest']::text[] = '{}'::jsonb
      AND jsonb_typeof(pending_evidence->'output') = 'object'
      AND jsonb_typeof(pending_evidence->'usageSnapshot') = 'object'
      AND jsonb_typeof(pending_evidence->'actualCostCredits') = 'string'
      AND pending_evidence->>'actualCostCredits' ~ '^(0|[1-9][0-9]{0,18})$'
      AND jsonb_typeof(pending_evidence->'resultDigest') = 'string'
      AND pending_evidence->>'resultDigest' ~ '^[0-9a-f]{64}$'
    )
  );

CREATE INDEX batch_items_processing_updated_idx
  ON batch_items(updated_at, id)
  WHERE status = 'processing';

COMMIT;
