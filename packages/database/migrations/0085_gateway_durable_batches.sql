-- 0085_gateway_durable_batches.sql
-- Durable stored batch container/items. Historical batch rows remain contract v1.

BEGIN;

ALTER TABLE batches
  ALTER COLUMN status TYPE VARCHAR(32),
  ADD COLUMN contract_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN billing_mode VARCHAR(16),
  ADD COLUMN idempotency_key_digest VARCHAR(64),
  ADD COLUMN request_fingerprint VARCHAR(64),
  ADD COLUMN queued_at TIMESTAMPTZ,
  ADD COLUMN reconcile_after TIMESTAMPTZ,
  ADD COLUMN terminal_at TIMESTAMPTZ;

ALTER TABLE batches
  ADD CONSTRAINT batches_durable_identity_check CHECK (
    (contract_version = 1
      AND billing_mode IS NULL
      AND idempotency_key_digest IS NULL
      AND request_fingerprint IS NULL)
    OR
    (contract_version = 5
      AND billing_mode IS NOT NULL
      AND idempotency_key_digest IS NOT NULL
      AND request_fingerprint IS NOT NULL
      AND billing_mode = 'stored'
      AND idempotency_key_digest ~ '^[0-9a-f]{64}$'
      AND request_fingerprint ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT batches_durable_identity_unique
    UNIQUE (org_id, contract_version, billing_mode, idempotency_key_digest);

CREATE INDEX batches_reconcile_idx
  ON batches(reconcile_after, created_at)
  WHERE terminal_at IS NULL AND reconcile_after IS NOT NULL;

CREATE TABLE batch_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  custom_id VARCHAR(128) NOT NULL,
  route_kind VARCHAR(32) NOT NULL,
  request_fingerprint VARCHAR(64) NOT NULL,
  request_body JSONB NOT NULL,
  billing_request_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  model_slug VARCHAR(128) NOT NULL,
  model_upstream_id UUID NOT NULL,
  upstream_id VARCHAR(64) NOT NULL,
  upstream_model_id VARCHAR(256) NOT NULL,
  adapter_key VARCHAR(64) NOT NULL,
  pricing_snapshot JSONB NOT NULL,
  provider_request JSONB NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'queued',
  output JSONB,
  error_code VARCHAR(64),
  result_digest VARCHAR(64),
  deadline_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT batch_items_parent_index_unique UNIQUE (batch_id, item_index),
  CONSTRAINT batch_items_parent_custom_unique UNIQUE (batch_id, custom_id),
  CONSTRAINT batch_items_billing_unique UNIQUE (billing_request_id),
  CONSTRAINT batch_items_billing_fkey
    FOREIGN KEY (billing_request_id)
    REFERENCES gateway_charge_admissions(billing_request_id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT batch_items_index_check CHECK (item_index BETWEEN 0 AND 99),
  CONSTRAINT batch_items_custom_id_check CHECK (custom_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT batch_items_route_check CHECK (route_kind IN ('chat','embeddings','completions')),
  CONSTRAINT batch_items_fingerprint_check CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT batch_items_request_check CHECK (jsonb_typeof(request_body) = 'object'),
  CONSTRAINT batch_items_pricing_check CHECK (jsonb_typeof(pricing_snapshot) = 'object'),
  CONSTRAINT batch_items_provider_request_check CHECK (jsonb_typeof(provider_request) = 'object'),
  CONSTRAINT batch_items_status_check CHECK (
    status IN ('queued','processing','completed','failed','reconciliation_required')
  ),
  CONSTRAINT batch_items_result_digest_check CHECK (
    result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT batch_items_terminal_shape_check CHECK (
    (status IN ('queued','processing')
      AND output IS NULL
      AND error_code IS NULL
      AND result_digest IS NULL
      AND settled_at IS NULL)
    OR
    (status = 'completed'
      AND output IS NOT NULL
      AND jsonb_typeof(output) = 'object'
      AND error_code IS NULL
      AND result_digest IS NOT NULL
      AND settled_at IS NOT NULL)
    OR
    (status IN ('failed','reconciliation_required')
      AND output IS NULL
      AND error_code IS NOT NULL
      AND result_digest IS NULL)
  )
);

CREATE INDEX batch_items_claim_idx
  ON batch_items(batch_id, status, item_index);

CREATE INDEX batch_items_billing_idx
  ON batch_items(billing_request_id);

COMMIT;
