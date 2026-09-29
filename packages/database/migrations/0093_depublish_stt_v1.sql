-- STT remains backlog-only for sold v1 until durable multipart identity,
-- trusted duration billing, exact receipt and recovery are implemented.
BEGIN;
UPDATE models
SET enabled=FALSE,
    status='depublished',
    depublished_reason='v1_scope_stt_deferred',
    updated_at=clock_timestamp()
WHERE (lower(coalesce(metadata->>'operation',''))='stt'
       OR slug='whisper-large-v3'
       OR EXISTS (SELECT 1 FROM unnest(tags) tag WHERE lower(tag) IN ('stt','transcription')))
  AND (
    enabled IS DISTINCT FROM FALSE
    OR status IS DISTINCT FROM 'depublished'
    OR depublished_reason IS DISTINCT FROM 'v1_scope_stt_deferred'
  );

CREATE FUNCTION aiag_block_sold_v1_stt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enabled AND NEW.status IN ('live','frozen') AND (
    NEW.slug='whisper-large-v3'
    OR lower(coalesce(NEW.metadata->>'operation',''))='stt'
    OR EXISTS (SELECT 1 FROM unnest(NEW.tags) tag WHERE lower(tag) IN ('stt','transcription'))
  ) THEN
    RAISE EXCEPTION 'STT_SOLD_V1_DISABLED';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER sold_v1_stt_guard
BEFORE INSERT OR UPDATE OF slug,enabled,status,metadata,tags ON models
FOR EACH ROW EXECUTE FUNCTION aiag_block_sold_v1_stt();
REVOKE EXECUTE ON FUNCTION aiag_block_sold_v1_stt() FROM PUBLIC;
COMMIT;
