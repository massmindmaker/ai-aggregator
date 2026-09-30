-- 0097_author_catalog_revision.sql
-- Catalog revision triggers for the author surface.
--
-- 0073 gives `gateway_catalog_revisions` a durable invalidation source, but it
-- only watches `models(id, slug, type, enabled, status)`, `model_upstreams` and
-- `upstreams`. The author admission predicate
-- (api-gateway/src/catalog/author-admission.ts) additionally depends on:
--
--   * `models.current_author_version_id` / `models.author_user_id`
--   * `author_model_versions`        (status, manifest_digest, model_id, author)
--   * `author_price_policies`        (price, approval/acceptance stamps, digest)
--   * `author_probe_operations`      (probe state gates listing)
--   * `users.is_active / is_banned`  (an author's account state gates listing)
--
-- None of those had a trigger, so the public `revision` on GET /v1/catalog was
-- held stable by the code-computed aggregate in `readAuthorRevision`
-- (public-catalog.ts). That aggregate cannot see a `current_author_version_id`
-- swap that leaves `max(updated_at)` and `max(approved_at)` untouched, nor a ban
-- on one author offset by an unban on another, so cursors stayed valid while
-- the advertised author price/availability was stale. This migration closes
-- that window at the source instead of in the reader.
--
-- ADDITIVE BY CONSTRUCTION. Migrations here are forward-only and untracked on
-- production, so this file must never drop or redefine a 0073 object. Every
-- function is CREATE OR REPLACE under a fresh `aiag_..._v1` name, and every
-- trigger is created only after `DROP TRIGGER IF EXISTS` on its OWN name, so
-- re-applying the file through psql is a no-op. The 0073 `models` triggers are
-- left exactly as they are; the author pointer gets its own additional
-- statement trigger, so a statement that moves both `enabled` and
-- `current_author_version_id` advances the revision twice. That is harmless —
-- revision is a monotonic invalidation token, not a count.
--
-- Semantics match 0073 exactly: one positive BIGINT bump per STATEMENT, inside
-- the mutating transaction (so a rollback also rolls back revision), and only
-- when a projected column actually changed — zero-row and value-preserving
-- statements do not advance it.

BEGIN;

-- ---------------------------------------------------------------------------
-- Insert / delete halves. Shared shape: a non-empty transition table means the
-- statement changed membership, which is always a catalog-visible change.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_author_versions_insert_v1()
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

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_author_versions_delete_v1()
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

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_author_policies_insert_v1()
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

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_author_policies_delete_v1()
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

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_author_probes_insert_v1()
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

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_author_probes_delete_v1()
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

-- ---------------------------------------------------------------------------
-- Update halves. The FULL JOIN on `id` is 0073's pattern: it reports rows that
-- were updated but whose id vanished from the new set, and vice versa, so a
-- statement that rewrites keys is still detected.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_author_versions_update_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- `public_manifest` carries the display name/description the projector
  -- coalesces into `models`, and `encrypted_token_envelope` gates whether the
  -- version can execute at all, so both belong in the watched tuple even though
  -- 0087's immutability trigger normally freezes them.
  IF EXISTS (
    SELECT 1
      FROM old_rows o
      FULL JOIN new_rows n USING (id)
     WHERE ROW(
             o.id, o.model_id, o.author_user_id, o.version_no,
             o.public_manifest, o.manifest_digest, o.encrypted_token_envelope,
             o.status, o.updated_at
           ) IS DISTINCT FROM ROW(
             n.id, n.model_id, n.author_user_id, n.version_no,
             n.public_manifest, n.manifest_digest, n.encrypted_token_envelope,
             n.status, n.updated_at
           )
  ) THEN
    PERFORM public.aiag_bump_gateway_catalog_revision_v1();
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_author_policies_update_v1()
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
             o.id, o.version_id, o.manifest_digest, o.price_microcredits,
             o.author_share_bps, o.availability_delay_seconds,
             o.policy_digest, o.accepted_by, o.accepted_at,
             o.approved_by, o.approved_at
           ) IS DISTINCT FROM ROW(
             n.id, n.version_id, n.manifest_digest, n.price_microcredits,
             n.author_share_bps, n.availability_delay_seconds,
             n.policy_digest, n.accepted_by, n.accepted_at,
             n.approved_by, n.approved_at
           )
  ) THEN
    PERFORM public.aiag_bump_gateway_catalog_revision_v1();
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION aiag_gateway_catalog_author_probes_update_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Only `state` reaching 'succeeded' admits a version to the catalog, but a
  -- move away from it de-admits one just as visibly, so the whole projected
  -- tuple is watched rather than a single column.
  IF EXISTS (
    SELECT 1
      FROM old_rows o
      FULL JOIN new_rows n USING (id)
     WHERE ROW(
             o.id, o.version_id, o.manifest_digest, o.request_digest,
             o.state, o.response_digest, o.error_code, o.finished_at
           ) IS DISTINCT FROM ROW(
             n.id, n.version_id, n.manifest_digest, n.request_digest,
             n.state, n.response_digest, n.error_code, n.finished_at
           )
  ) THEN
    PERFORM public.aiag_bump_gateway_catalog_revision_v1();
  END IF;
  RETURN NULL;
END
$$;

-- The author pointer on `models`. Deliberately a SEPARATE trigger from 0073's
-- `gateway_catalog_models_update_revision`, which watches only
-- (id, slug, type, enabled, status) and therefore misses a
-- `current_author_version_id` swap that leaves every other column alone. This
-- is the specific stale-price window that motivated this migration.
CREATE OR REPLACE FUNCTION aiag_gateway_catalog_models_author_update_v1()
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
             o.id, o.current_author_version_id, o.author_user_id
           ) IS DISTINCT FROM ROW(
             n.id, n.current_author_version_id, n.author_user_id
           )
  ) THEN
    PERFORM public.aiag_bump_gateway_catalog_revision_v1();
  END IF;
  RETURN NULL;
END
$$;

-- An author's account state is part of the admission predicate, but `users` is
-- a hot table touched by unrelated writes. Scoping the bump to accounts that
-- actually own a version keeps ordinary sign-in/profile updates free, and stops
-- the ban-then-unban-someone-else case from cancelling out in an aggregate.
CREATE OR REPLACE FUNCTION aiag_gateway_catalog_author_owners_update_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM old_rows o
      FULL JOIN new_rows n USING (id)
     WHERE ROW(o.id, o.is_active, o.is_banned)
           IS DISTINCT FROM ROW(n.id, n.is_active, n.is_banned)
       AND (EXISTS (SELECT 1 FROM public.author_model_versions v WHERE v.author_user_id = o.id)
         OR EXISTS (SELECT 1 FROM public.author_model_versions v WHERE v.author_user_id = n.id))
  ) THEN
    PERFORM public.aiag_bump_gateway_catalog_revision_v1();
  END IF;
  RETURN NULL;
END
$$;

-- Application code cannot own a bump; only the statement triggers above call
-- the 0073 routine. Same posture as 0073's own REVOKE block.
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_author_versions_insert_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_author_versions_update_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_author_versions_delete_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_author_policies_insert_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_author_policies_update_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_author_policies_delete_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_author_probes_insert_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_author_probes_update_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_author_probes_delete_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_models_author_update_v1() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_gateway_catalog_author_owners_update_v1() FROM PUBLIC;

-- DROP IF EXISTS is scoped to each trigger's own new name. No 0073 trigger name
-- appears here, so re-running this file cannot disturb the original set.
DROP TRIGGER IF EXISTS gateway_catalog_author_versions_insert_revision ON author_model_versions;
CREATE TRIGGER gateway_catalog_author_versions_insert_revision
AFTER INSERT ON author_model_versions
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_author_versions_insert_v1();

DROP TRIGGER IF EXISTS gateway_catalog_author_versions_update_revision ON author_model_versions;
CREATE TRIGGER gateway_catalog_author_versions_update_revision
AFTER UPDATE ON author_model_versions
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_author_versions_update_v1();

DROP TRIGGER IF EXISTS gateway_catalog_author_versions_delete_revision ON author_model_versions;
CREATE TRIGGER gateway_catalog_author_versions_delete_revision
AFTER DELETE ON author_model_versions
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_author_versions_delete_v1();

DROP TRIGGER IF EXISTS gateway_catalog_author_policies_insert_revision ON author_price_policies;
CREATE TRIGGER gateway_catalog_author_policies_insert_revision
AFTER INSERT ON author_price_policies
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_author_policies_insert_v1();

DROP TRIGGER IF EXISTS gateway_catalog_author_policies_update_revision ON author_price_policies;
CREATE TRIGGER gateway_catalog_author_policies_update_revision
AFTER UPDATE ON author_price_policies
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_author_policies_update_v1();

DROP TRIGGER IF EXISTS gateway_catalog_author_policies_delete_revision ON author_price_policies;
CREATE TRIGGER gateway_catalog_author_policies_delete_revision
AFTER DELETE ON author_price_policies
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_author_policies_delete_v1();

DROP TRIGGER IF EXISTS gateway_catalog_author_probes_insert_revision ON author_probe_operations;
CREATE TRIGGER gateway_catalog_author_probes_insert_revision
AFTER INSERT ON author_probe_operations
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_author_probes_insert_v1();

DROP TRIGGER IF EXISTS gateway_catalog_author_probes_update_revision ON author_probe_operations;
CREATE TRIGGER gateway_catalog_author_probes_update_revision
AFTER UPDATE ON author_probe_operations
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_author_probes_update_v1();

DROP TRIGGER IF EXISTS gateway_catalog_author_probes_delete_revision ON author_probe_operations;
CREATE TRIGGER gateway_catalog_author_probes_delete_revision
AFTER DELETE ON author_probe_operations
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_author_probes_delete_v1();

-- Additional trigger on `models`; the 0073 trio on this table is untouched.
DROP TRIGGER IF EXISTS gateway_catalog_models_author_update_revision ON models;
CREATE TRIGGER gateway_catalog_models_author_update_revision
AFTER UPDATE ON models
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_models_author_update_v1();

DROP TRIGGER IF EXISTS gateway_catalog_author_owners_update_revision ON users;
CREATE TRIGGER gateway_catalog_author_owners_update_revision
AFTER UPDATE ON users
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION aiag_gateway_catalog_author_owners_update_v1();

COMMENT ON FUNCTION aiag_gateway_catalog_models_author_update_v1() IS
  'Bumps the catalog revision when the author pointer on models changes; 0073 watches a disjoint column set.';
COMMENT ON FUNCTION aiag_gateway_catalog_author_owners_update_v1() IS
  'Bumps the catalog revision when an author account is deactivated or banned, scoped to accounts owning a version.';

COMMIT;
