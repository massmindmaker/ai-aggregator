-- Preserve the accepted nullable cursor contract for embedded JSON values.
CREATE OR REPLACE FUNCTION aiag_ton_reconciliation_cursor_v1(_cursor JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF _cursor IS NULL OR _cursor='null'::jsonb THEN RETURN; END IF;
  PERFORM aiag_ton_keys_v1(
    _cursor,
    ARRAY['schemaVersion','beforeLt','beforeTransactionHash','cycleUpperLt']
  );
  IF _cursor->'schemaVersion' IS DISTINCT FROM '1'::jsonb THEN
    RAISE EXCEPTION 'TON_INVALID_CURSOR';
  END IF;
  PERFORM aiag_ton_text_v1(_cursor->'beforeLt','\A(0|[1-9][0-9]{0,77})\Z',78);
  PERFORM aiag_ton_text_v1(_cursor->'beforeTransactionHash','\A[0-9a-f]{64}\Z',64);
  PERFORM aiag_ton_text_v1(_cursor->'cycleUpperLt','\A(0|[1-9][0-9]{0,77})\Z',78);
  IF (_cursor->>'beforeLt')::numeric>(_cursor->>'cycleUpperLt')::numeric THEN
    RAISE EXCEPTION 'TON_INVALID_CURSOR';
  END IF;
END
$$;

REVOKE EXECUTE ON FUNCTION aiag_ton_reconciliation_cursor_v1(jsonb) FROM PUBLIC;
