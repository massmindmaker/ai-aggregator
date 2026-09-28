-- Additive author lifecycle. Candidate content and historical money paths stay immutable.
BEGIN;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'system';
CREATE TABLE author_probe_operations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 version_id UUID NOT NULL UNIQUE REFERENCES author_model_versions(id) ON DELETE RESTRICT,
 manifest_digest TEXT NOT NULL CHECK(manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
 request_digest TEXT NOT NULL CHECK(request_digest ~ '^sha256:[0-9a-f]{64}$'),
 claim_token UUID NOT NULL,
 requested_by UUID NOT NULL REFERENCES users(id),
 state TEXT NOT NULL CHECK(state IN('dispatching','succeeded','failed','unknown')),
 deadline_at TIMESTAMPTZ NOT NULL,
 response_digest TEXT CHECK(response_digest ~ '^sha256:[0-9a-f]{64}$'),
 error_code TEXT CHECK(error_code IN('ENDPOINT_BLOCKED','ENDPOINT_UNAVAILABLE','INVALID_PROBE_RESPONSE','KEY_UNAVAILABLE')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 finished_at TIMESTAMPTZ,
 CHECK((state='succeeded' AND response_digest IS NOT NULL AND error_code IS NULL AND finished_at IS NOT NULL)
  OR (state IN('failed','unknown') AND response_digest IS NULL AND error_code IS NOT NULL AND finished_at IS NOT NULL)
  OR (state='dispatching' AND response_digest IS NULL AND error_code IS NULL AND finished_at IS NULL))
);
CREATE TABLE author_price_policies (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 version_id UUID NOT NULL UNIQUE REFERENCES author_model_versions(id) ON DELETE RESTRICT,
 manifest_digest TEXT NOT NULL CHECK(manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
 price_microcredits BIGINT NOT NULL CHECK(price_microcredits BETWEEN 1 AND 922337203685477580),
 author_share_bps INTEGER NOT NULL CHECK(author_share_bps BETWEEN 0 AND 10000),
 availability_delay_seconds INTEGER NOT NULL DEFAULT 2592000 CHECK(availability_delay_seconds BETWEEN 0 AND 7776000),
 rights_reference TEXT NOT NULL CHECK(length(rights_reference) BETWEEN 3 AND 512),
 consent_reference TEXT NOT NULL CHECK(length(consent_reference) BETWEEN 3 AND 512),
 policy_digest TEXT NOT NULL CHECK(policy_digest ~ '^sha256:[0-9a-f]{64}$'),
 proposed_by UUID NOT NULL REFERENCES users(id),
 accepted_by UUID REFERENCES users(id), accepted_at TIMESTAMPTZ,
 approved_by UUID REFERENCES users(id), approved_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK((accepted_by IS NULL)=(accepted_at IS NULL)),
 CHECK((approved_by IS NULL)=(approved_at IS NULL)),
 CHECK(approved_at IS NULL OR accepted_at IS NOT NULL)
);

CREATE FUNCTION aiag_author_immutable_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='author_probe_operations' THEN
  IF (to_jsonb(NEW)-ARRAY['state','response_digest','error_code','finished_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','response_digest','error_code','finished_at'])
     OR OLD.state<>'dispatching' AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'AUTHOR_PROBE_IMMUTABLE'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['accepted_by','accepted_at','approved_by','approved_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['accepted_by','accepted_at','approved_by','approved_at'])
    OR (OLD.accepted_at IS NOT NULL AND (NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR NEW.accepted_by IS DISTINCT FROM OLD.accepted_by))
    OR (OLD.approved_at IS NOT NULL AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by))
  THEN RAISE EXCEPTION 'AUTHOR_POLICY_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER author_probe_identity BEFORE UPDATE ON author_probe_operations FOR EACH ROW EXECUTE FUNCTION aiag_author_immutable_identity();
CREATE TRIGGER author_policy_identity BEFORE UPDATE ON author_price_policies FOR EACH ROW EXECUTE FUNCTION aiag_author_immutable_identity();

CREATE FUNCTION aiag_require_author_admin(_actor UUID) RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE _email TEXT;
BEGIN
 SELECT email INTO _email FROM users WHERE id=_actor AND role='admin' AND is_active AND NOT is_banned;
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTHOR_ADMIN_REQUIRED'; END IF;
 RETURN _email;
END $$;

CREATE FUNCTION aiag_claim_author_probe(_version UUID,_digest TEXT,_actor UUID,_body_digest TEXT,_claim UUID)
RETURNS TABLE(id UUID,state TEXT,did_claim BOOLEAN,deadline_at TIMESTAMPTZ) LANGUAGE plpgsql AS $$
DECLARE _v author_model_versions%ROWTYPE; _p author_probe_operations%ROWTYPE; _email TEXT; _inserted BOOLEAN;
BEGIN
 _email:=aiag_require_author_admin(_actor);
 IF _claim IS NULL OR _body_digest IS NULL OR _body_digest !~ '^sha256:[0-9a-f]{64}$' THEN RAISE EXCEPTION 'AUTHOR_PROBE_INVALID'; END IF;
 PERFORM 1 FROM models m WHERE m.id=(SELECT v.model_id FROM author_model_versions v WHERE v.id=_version) FOR UPDATE;
 SELECT * INTO _v FROM author_model_versions v WHERE v.id=_version FOR UPDATE;
 IF NOT FOUND OR _v.manifest_digest IS DISTINCT FROM _digest OR _v.status<>'candidate' THEN RAISE EXCEPTION 'AUTHOR_VERSION_CONFLICT'; END IF;
 IF _v.author_user_id=_actor THEN RAISE EXCEPTION 'AUTHOR_INDEPENDENT_REVIEW_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM users WHERE users.id=_v.author_user_id AND is_active AND NOT is_banned) THEN RAISE EXCEPTION 'AUTHOR_OWNER_REQUIRED'; END IF;
 INSERT INTO author_probe_operations(version_id,manifest_digest,request_digest,claim_token,requested_by,state,deadline_at)
 VALUES(_version,_digest,_body_digest,_claim,_actor,'dispatching',clock_timestamp()+INTERVAL '10 seconds')
 ON CONFLICT(version_id) DO NOTHING;
 _inserted:=FOUND;
 SELECT * INTO _p FROM author_probe_operations p WHERE p.version_id=_version FOR UPDATE;
 IF _p.manifest_digest IS DISTINCT FROM _digest OR _p.request_digest IS DISTINCT FROM _body_digest THEN RAISE EXCEPTION 'AUTHOR_PROBE_CONFLICT'; END IF;
 IF NOT _inserted AND _p.state='dispatching' AND _p.deadline_at<=clock_timestamp() THEN
  UPDATE author_probe_operations p SET state='unknown',error_code='ENDPOINT_UNAVAILABLE',finished_at=clock_timestamp() WHERE p.id=_p.id RETURNING * INTO _p;
 END IF;
 IF _inserted THEN
  INSERT INTO audit_log(actor_email,actor_type,action,resource_type,resource_id,details)
  VALUES(_email,'admin','author.probe.claim','author_version',_version::text,jsonb_build_object('operation_id',_p.id));
 END IF;
 RETURN QUERY SELECT _p.id,_p.state,_inserted,_p.deadline_at;
END $$;

CREATE FUNCTION aiag_complete_author_probe(_operation UUID,_claim UUID,_state TEXT,_response TEXT,_error TEXT)
RETURNS TABLE(id UUID,state TEXT) LANGUAGE plpgsql AS $$
DECLARE _p author_probe_operations%ROWTYPE;
BEGIN
 SELECT * INTO _p FROM author_probe_operations p WHERE p.id=_operation FOR UPDATE;
 IF NOT FOUND OR _claim IS NULL OR _p.claim_token IS DISTINCT FROM _claim THEN RAISE EXCEPTION 'AUTHOR_PROBE_CONFLICT'; END IF;
 IF _state IS NULL OR _state NOT IN('succeeded','failed','unknown')
  OR (_state='succeeded' AND (_response IS NULL OR _response !~ '^sha256:[0-9a-f]{64}$' OR _error IS NOT NULL))
  OR (_state<>'succeeded' AND (_response IS NOT NULL OR _error IS NULL OR _error NOT IN('ENDPOINT_BLOCKED','ENDPOINT_UNAVAILABLE','INVALID_PROBE_RESPONSE','KEY_UNAVAILABLE')))
 THEN RAISE EXCEPTION 'AUTHOR_PROBE_INVALID'; END IF;
 IF _p.state<>'dispatching' THEN
  IF _p.state IS DISTINCT FROM _state OR _p.response_digest IS DISTINCT FROM _response OR _p.error_code IS DISTINCT FROM _error THEN RAISE EXCEPTION 'AUTHOR_PROBE_CONFLICT'; END IF;
  RETURN QUERY SELECT _p.id,_p.state; RETURN;
 END IF;
 IF _p.deadline_at<=clock_timestamp() THEN _state:='unknown';_response:=NULL;_error:='ENDPOINT_UNAVAILABLE'; END IF;
 UPDATE author_probe_operations p SET state=_state,response_digest=_response,error_code=_error,finished_at=clock_timestamp() WHERE p.id=_operation RETURNING * INTO _p;
 RETURN QUERY SELECT _p.id,_p.state;
END $$;

CREATE FUNCTION aiag_propose_author_policy(_version UUID,_digest TEXT,_actor UUID,_price BIGINT,_share INTEGER,_rights TEXT,_consent TEXT,_delay INTEGER DEFAULT 2592000)
RETURNS TABLE(id UUID,policy_digest TEXT) LANGUAGE plpgsql AS $$
DECLARE _v author_model_versions%ROWTYPE; _p author_price_policies%ROWTYPE; _email TEXT; _terms TEXT; _policy_digest TEXT;
BEGIN
 _email:=aiag_require_author_admin(_actor);
 IF _price IS NULL OR _price NOT BETWEEN 1 AND 922337203685477580 OR _share IS NULL OR _share NOT BETWEEN 0 AND 10000
  OR _delay IS NULL OR _delay NOT BETWEEN 0 AND 7776000
  OR _rights IS NULL OR length(_rights) NOT BETWEEN 3 AND 512 OR _consent IS NULL OR length(_consent) NOT BETWEEN 3 AND 512
 THEN RAISE EXCEPTION 'AUTHOR_POLICY_INVALID'; END IF;
 PERFORM 1 FROM models m WHERE m.id=(SELECT v.model_id FROM author_model_versions v WHERE v.id=_version) FOR UPDATE;
 SELECT * INTO _v FROM author_model_versions v WHERE v.id=_version FOR UPDATE;
 IF NOT FOUND OR _v.manifest_digest IS DISTINCT FROM _digest OR _v.status<>'candidate' THEN RAISE EXCEPTION 'AUTHOR_VERSION_CONFLICT'; END IF;
 IF _v.author_user_id=_actor THEN RAISE EXCEPTION 'AUTHOR_INDEPENDENT_REVIEW_REQUIRED'; END IF;
 _terms:=jsonb_build_object('version_id',_version,'manifest_digest',_digest,'author_id',_v.author_user_id,
  'price_microcredits',_price::text,'author_share_bps',_share,'availability_delay_seconds',_delay,'rights_reference',_rights,'consent_reference',_consent)::text;
 _policy_digest:='sha256:'||encode(sha256(convert_to(_terms,'UTF8')),'hex');
 INSERT INTO author_price_policies(version_id,manifest_digest,price_microcredits,author_share_bps,availability_delay_seconds,rights_reference,consent_reference,policy_digest,proposed_by)
 VALUES(_version,_digest,_price,_share,_delay,_rights,_consent,_policy_digest,_actor) ON CONFLICT(version_id) DO NOTHING;
 SELECT * INTO _p FROM author_price_policies p WHERE p.version_id=_version;
 IF _p.policy_digest IS DISTINCT FROM _policy_digest THEN RAISE EXCEPTION 'AUTHOR_POLICY_CONFLICT'; END IF;
 RETURN QUERY SELECT _p.id,_p.policy_digest;
END $$;

CREATE FUNCTION aiag_accept_author_policy(_policy UUID,_digest TEXT,_actor UUID)
RETURNS TABLE(id UUID,policy_digest TEXT) LANGUAGE plpgsql AS $$
DECLARE _p author_price_policies%ROWTYPE; _author UUID;
BEGIN
 SELECT v.author_user_id INTO _author FROM author_price_policies p JOIN author_model_versions v ON v.id=p.version_id WHERE p.id=_policy;
 IF _author IS NULL OR _author IS DISTINCT FROM _actor OR NOT EXISTS(SELECT 1 FROM users WHERE users.id=_actor AND is_active AND NOT is_banned)
 THEN RAISE EXCEPTION 'AUTHOR_OWNER_REQUIRED'; END IF;
 SELECT * INTO _p FROM author_price_policies p WHERE p.id=_policy FOR UPDATE;
 IF _p.policy_digest IS DISTINCT FROM _digest THEN RAISE EXCEPTION 'AUTHOR_POLICY_CONFLICT'; END IF;
 IF _p.accepted_at IS NULL THEN
  UPDATE author_price_policies p SET accepted_by=_actor,accepted_at=clock_timestamp() WHERE p.id=_policy RETURNING * INTO _p;
  INSERT INTO audit_log(actor_email,actor_type,action,resource_type,resource_id,details)
  SELECT email,'user','author.policy.accept','author_policy',_policy::text,jsonb_build_object('policy_digest',_digest) FROM users WHERE users.id=_actor;
 END IF;
 RETURN QUERY SELECT _p.id,_p.policy_digest;
END $$;

CREATE FUNCTION aiag_approve_author_version(_version UUID,_policy UUID,_digest TEXT,_actor UUID,_expected_current UUID)
RETURNS TABLE(version_id UUID,policy_id UUID) LANGUAGE plpgsql AS $$
DECLARE _v author_model_versions%ROWTYPE; _p author_price_policies%ROWTYPE; _m models%ROWTYPE; _email TEXT;
BEGIN
 _email:=aiag_require_author_admin(_actor);
 SELECT * INTO _m FROM models m WHERE m.id=(SELECT v.model_id FROM author_model_versions v WHERE v.id=_version) FOR UPDATE;
 SELECT * INTO _v FROM author_model_versions v WHERE v.id=_version FOR UPDATE;
 IF NOT FOUND OR _v.manifest_digest IS DISTINCT FROM _digest OR _m.id IS NULL OR _m.author_user_id IS DISTINCT FROM _v.author_user_id THEN RAISE EXCEPTION 'AUTHOR_VERSION_CONFLICT'; END IF;
 IF _v.author_user_id=_actor THEN RAISE EXCEPTION 'AUTHOR_INDEPENDENT_REVIEW_REQUIRED'; END IF;
 SELECT * INTO _p FROM author_price_policies p WHERE p.id=_policy AND p.version_id=_version FOR UPDATE;
 IF NOT FOUND OR _p.manifest_digest IS DISTINCT FROM _digest OR _p.accepted_by IS DISTINCT FROM _v.author_user_id OR _p.accepted_at IS NULL
  OR NOT EXISTS(SELECT 1 FROM author_probe_operations probe WHERE probe.version_id=_version AND probe.manifest_digest=_digest AND probe.state='succeeded')
 THEN RAISE EXCEPTION 'AUTHOR_APPROVAL_NOT_READY'; END IF;
 IF _m.current_author_version_id=_version AND _p.approved_at IS NOT NULL AND _v.status='approved' AND _m.status='live' THEN
  RETURN QUERY SELECT _version,_policy; RETURN;
 END IF;
 IF _m.current_author_version_id IS DISTINCT FROM _expected_current OR _m.status NOT IN('draft','live') OR _v.status NOT IN('candidate','approved')
 THEN RAISE EXCEPTION 'AUTHOR_VERSION_CONFLICT'; END IF;
 UPDATE author_price_policies p SET approved_by=coalesce(p.approved_by,_actor),approved_at=coalesce(p.approved_at,clock_timestamp()) WHERE p.id=_policy;
 UPDATE author_model_versions SET status='approved',updated_at=clock_timestamp() WHERE author_model_versions.id=_version;
 UPDATE models SET current_author_version_id=_version,status='live',enabled=true,updated_at=clock_timestamp(),metadata=metadata-'review_state',
  display_name=coalesce(_v.public_manifest#>>'{model,displayName}',display_name),description=coalesce(_v.public_manifest#>>'{model,description}',description)
 WHERE models.id=_m.id AND current_author_version_id IS NOT DISTINCT FROM _expected_current;
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTHOR_VERSION_CONFLICT'; END IF;
 INSERT INTO audit_log(actor_email,actor_type,action,resource_type,resource_id,details)
 VALUES(_email,'admin','author.version.approve','model',_m.id::text,jsonb_build_object('version_id',_version,'policy_id',_policy,'manifest_digest',_digest));
 RETURN QUERY SELECT _version,_policy;
END $$;

CREATE FUNCTION aiag_require_approved_author_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.author_user_id IS NULL OR NEW.status<>'live' OR NOT NEW.enabled THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM author_model_versions WHERE model_id=NEW.id) AND NOT EXISTS(
  SELECT 1 FROM author_model_versions v JOIN author_price_policies p ON p.version_id=v.id JOIN author_probe_operations probe ON probe.version_id=v.id
  JOIN users u ON u.id=v.author_user_id
  WHERE v.id=NEW.current_author_version_id AND v.model_id=NEW.id AND v.author_user_id=NEW.author_user_id AND v.status='approved'
   AND p.approved_at IS NOT NULL AND p.accepted_by=v.author_user_id AND p.manifest_digest=v.manifest_digest AND probe.state='succeeded' AND u.is_active AND NOT u.is_banned
 ) THEN RAISE EXCEPTION 'AUTHOR_APPROVAL_NOT_READY'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER author_activation_guard BEFORE INSERT OR UPDATE OF status,enabled,current_author_version_id,author_user_id ON models
 FOR EACH ROW EXECUTE FUNCTION aiag_require_approved_author_activation();

COMMIT;
