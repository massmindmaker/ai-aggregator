-- AG-P3 Batch A: append-only author model versions.
BEGIN;

ALTER TABLE models ADD COLUMN current_author_version_id UUID;

CREATE TABLE author_model_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id UUID NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
  author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  public_manifest JSONB NOT NULL,
  manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  encrypted_token_envelope JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('candidate','approved','rejected','depublished')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT author_model_versions_model_version_uq UNIQUE (model_id, version_no),
  CONSTRAINT author_model_versions_model_id_uq UNIQUE (model_id, id),
  CONSTRAINT author_model_versions_manifest_object CHECK (jsonb_typeof(public_manifest) = 'object'),
  CONSTRAINT author_model_versions_token_object CHECK (
    jsonb_typeof(encrypted_token_envelope) = 'object'
    AND encrypted_token_envelope ?& ARRAY['ciphertext','iv','tag','version']
    AND encrypted_token_envelope->>'version' = '1'
    AND NOT encrypted_token_envelope ? 'auth_token'
  )
);

ALTER TABLE models ADD CONSTRAINT models_current_author_version_fk
  FOREIGN KEY (id, current_author_version_id)
  REFERENCES author_model_versions(model_id, id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION reject_author_model_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.model_id IS DISTINCT FROM OLD.model_id
     OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.public_manifest IS DISTINCT FROM OLD.public_manifest
     OR NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest
     OR NEW.encrypted_token_envelope IS DISTINCT FROM OLD.encrypted_token_envelope
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'author model version content is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER author_model_versions_immutable
  BEFORE UPDATE ON author_model_versions
  FOR EACH ROW EXECUTE FUNCTION reject_author_model_version_mutation();

CREATE INDEX author_model_versions_model_idx ON author_model_versions(model_id, status);
CREATE INDEX author_model_versions_author_idx ON author_model_versions(author_user_id, created_at);
COMMIT;
