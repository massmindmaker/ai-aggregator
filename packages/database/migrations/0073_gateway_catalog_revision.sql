-- 0073_gateway_catalog_revision.sql
-- Durable invalidation source for the authenticated public catalog.
--
-- One positive BIGINT revision is advanced once per statement whenever a
-- registry fact used by catalog projection changes. Transition tables keep
-- zero-row and value-preserving UPDATE statements from advancing it. The bump
-- stays in the mutating transaction, so a rollback also rolls back revision.

CREATE TABLE IF NOT EXISTS gateway_catalog_revisions (
  singleton BOOLEAN NOT NULL DEFAULT TRUE,
  revision BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT gateway_catalog_revisions_pkey PRIMARY KEY (singleton),
  CONSTRAINT gateway_catalog_revisions_singleton_true CHECK (singleton),
  CONSTRAINT gateway_catalog_revisions_revision_positive
    CHECK (revision > 0 AND revision < 9223372036854775807)
);

INSERT INTO gateway_catalog_revisions(singleton, revision)
VALUES (TRUE, 1)
ON CONFLICT (singleton) DO NOTHING;

-- This is the only read seam for the catalog projector. Structural
-- constraints prevent ordinary corruption; the explicit checks also fail
-- closed if a privileged/manual operation bypassed those constraints.
CREATE OR REPLACE FUNCTION aiag_read_gateway_catalog_revision_v1()
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _row_count BIGINT;
  _singleton_count BIGINT;
  _revision BIGINT;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE singleton IS TRUE),
         min(revision)
    INTO _row_count, _singleton_count, _revision
    FROM public.gateway_catalog_revisions;

  IF _row_count <> 1
     OR _singleton_count <> 1
     OR _revision IS NULL
     OR _revision <= 0
     OR _revision >= 9223372036854775807 THEN
    RAISE EXCEPTION 'CATALOG_REVISION_INVALID' USING ERRCODE = '22000';
  END IF;

  RETURN _revision;
END
$$;

-- Application code cannot own a bump. Only the statement trigger functions
-- below invoke this routine. The upper guard rejects a mutation before BIGINT
-- addition can overflow or commit an unreadable maximum value.
CREATE OR REPLACE FUNCTION aiag_bump_gateway_catalog_revision_v1()
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _current BIGINT;
  _updated BIGINT;
BEGIN
  -- Lock before reading so two concurrent registry statements queue and each
  -- receives its own committed increment instead of racing a stale CAS value.
  PERFORM 1
    FROM public.gateway_catalog_revisions
    FOR UPDATE;
  _current := public.aiag_read_gateway_catalog_revision_v1();
  IF _current >= 9223372036854775806 THEN
    RAISE EXCEPTION 'CATALOG_REVISION_INVALID' USING ERRCODE = '22000';
  END IF;

  UPDATE public.gateway_catalog_revisions
     SET revision = revision + 1
   WHERE singleton IS TRUE
     AND revision = _current;
  GET DIAGNOSTICS _updated = ROW_COUNT;

  IF _updated <> 1 THEN
    RAISE EXCEPTION 'CATALOG_REVISION_INVALID' USING ERRCODE = '22000';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_models_insert_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM new_rows) THEN
    PERFORM public.aiag_bump_gateway_catalog_revision_v1();
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_models_update_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM old_rows o
      FULL JOIN new_rows n USING (id)
     WHERE ROW(o.id, o.slug, o.type, o.enabled, o.status)
           IS DISTINCT FROM
           ROW(n.id, n.slug, n.type, n.enabled, n.status)
  ) THEN
    PERFORM public.aiag_bump_gateway_catalog_revision_v1();
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_models_delete_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM old_rows) THEN
    PERFORM public.aiag_bump_gateway_catalog_revision_v1();
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_candidates_insert_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM new_rows) THEN
    PERFORM public.aiag_bump_gateway_catalog_revision_v1();
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_candidates_update_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM old_rows o
      FULL JOIN new_rows n USING (id)
     WHERE ROW(
             o.id, o.model_id, o.upstream_id, o.upstream_model_id,
             o.price_per_1k_input, o.price_per_1k_output,
             o.price_per_image, o.price_per_audio_sec, o.markup,
             o.enabled, o.priority, o.egress_proxy
           ) IS DISTINCT FROM ROW(
             n.id, n.model_id, n.upstream_id, n.upstream_model_id,
             n.price_per_1k_input, n.price_per_1k_output,
             n.price_per_image, n.price_per_audio_sec, n.markup,
             n.enabled, n.priority, n.egress_proxy
           )
  ) THEN
    PERFORM public.aiag_bump_gateway_catalog_revision_v1();
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_candidates_delete_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM old_rows) THEN
    PERFORM public.aiag_bump_gateway_catalog_revision_v1();
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_upstreams_insert_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM new_rows) THEN
    PERFORM public.aiag_bump_gateway_catalog_revision_v1();
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_upstreams_update_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM old_rows o
      FULL JOIN new_rows n USING (id)
     WHERE ROW(
             o.id, o.provider, o.ru_residency, o.enabled,
             o.latency_p50_ms, o.uptime, o.base_url
           ) IS DISTINCT FROM ROW(
             n.id, n.provider, n.ru_residency, n.enabled,
             n.latency_p50_ms, n.uptime, n.base_url
           )
  ) THEN
    PERFORM public.aiag_bump_gateway_catalog_revision_v1();
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_upstreams_delete_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM old_rows) THEN
    PERFORM public.aiag_bump_gateway_catalog_revision_v1();
  END IF;
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION aiag_bump_gateway_catalog_revision_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_models_insert_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_models_update_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_models_delete_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_candidates_insert_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_candidates_update_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_candidates_delete_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_upstreams_insert_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_upstreams_update_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_upstreams_delete_v1() FROM PUBLIC;

DROP TRIGGER IF EXISTS gateway_catalog_models_insert_revision ON models;
CREATE TRIGGER gateway_catalog_models_insert_revision
AFTER INSERT ON models
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_models_insert_v1();

DROP TRIGGER IF EXISTS gateway_catalog_models_update_revision ON models;
CREATE TRIGGER gateway_catalog_models_update_revision
AFTER UPDATE ON models
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_models_update_v1();

DROP TRIGGER IF EXISTS gateway_catalog_models_delete_revision ON models;
CREATE TRIGGER gateway_catalog_models_delete_revision
AFTER DELETE ON models
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_models_delete_v1();

DROP TRIGGER IF EXISTS gateway_catalog_candidates_insert_revision ON model_upstreams;
CREATE TRIGGER gateway_catalog_candidates_insert_revision
AFTER INSERT ON model_upstreams
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_candidates_insert_v1();

DROP TRIGGER IF EXISTS gateway_catalog_candidates_update_revision ON model_upstreams;
CREATE TRIGGER gateway_catalog_candidates_update_revision
AFTER UPDATE ON model_upstreams
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_candidates_update_v1();

DROP TRIGGER IF EXISTS gateway_catalog_candidates_delete_revision ON model_upstreams;
CREATE TRIGGER gateway_catalog_candidates_delete_revision
AFTER DELETE ON model_upstreams
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_candidates_delete_v1();

DROP TRIGGER IF EXISTS gateway_catalog_upstreams_insert_revision ON upstreams;
CREATE TRIGGER gateway_catalog_upstreams_insert_revision
AFTER INSERT ON upstreams
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_upstreams_insert_v1();

DROP TRIGGER IF EXISTS gateway_catalog_upstreams_update_revision ON upstreams;
CREATE TRIGGER gateway_catalog_upstreams_update_revision
AFTER UPDATE ON upstreams
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_upstreams_update_v1();

DROP TRIGGER IF EXISTS gateway_catalog_upstreams_delete_revision ON upstreams;
CREATE TRIGGER gateway_catalog_upstreams_delete_revision
AFTER DELETE ON upstreams
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_upstreams_delete_v1();

COMMENT ON TABLE gateway_catalog_revisions IS
  'One durable positive revision for bounded public catalog invalidation.';
COMMENT ON FUNCTION aiag_read_gateway_catalog_revision_v1() IS
  'Fail-closed read seam for the public catalog revision singleton.';
