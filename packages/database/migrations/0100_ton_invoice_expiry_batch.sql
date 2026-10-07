-- 0100: batched TON invoice expiry (plan AG-TON-L task 3.3).
-- Closes the stale `pending` tail in bounded batches; the reconciliation claim
-- path already refuses expired invoices (0092 trigger), so this sweep never
-- touches money or credits — it only makes invoice state honest.
CREATE FUNCTION aiag_expire_stale_ton_invoices_v1(_limit INTEGER) RETURNS INTEGER
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _expired INTEGER;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 1000 THEN RAISE EXCEPTION 'TON_EXPIRY_LIMIT_INVALID'; END IF;
  WITH _batch AS (
    SELECT id FROM public.ton_invoices
    WHERE status='pending' AND expires_at<=clock_timestamp()
    ORDER BY expires_at, id
    LIMIT _limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ton_invoices i SET status='expired', updated_at=clock_timestamp()
  FROM _batch WHERE i.id=_batch.id AND i.status='pending';
  GET DIAGNOSTICS _expired = ROW_COUNT;
  RETURN _expired;
END $$;
REVOKE EXECUTE ON FUNCTION aiag_expire_stale_ton_invoices_v1(integer) FROM PUBLIC;
