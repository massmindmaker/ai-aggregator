-- Web-owned intent and one wallet-dispatch claim. Client reports never grant credits.
BEGIN;
ALTER TABLE organizations ADD CONSTRAINT organizations_id_owner_unique UNIQUE(id,owner_id);
ALTER TABLE user_ton_wallets ADD CONSTRAINT user_ton_wallets_id_user_unique UNIQUE(id,user_id);
ALTER TABLE ton_invoices ADD CONSTRAINT ton_invoices_id_org_owner_unique UNIQUE(id,org_id,owner_user_id);

CREATE TABLE user_ton_checkouts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 org_id UUID NOT NULL,
 wallet_id UUID NOT NULL,
 package_id TEXT NOT NULL,
 key_hash TEXT NOT NULL CHECK(length(key_hash)=64 AND key_hash ~ '^[a-f0-9]{64}$'),
 invoice_id UUID NOT NULL UNIQUE,
 policy_snapshot JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 send_attempt_id UUID,
 send_claimed_at TIMESTAMPTZ,
 client_report TEXT CHECK(client_report IN('client_sent','client_rejected','client_unknown')),
 client_reported_at TIMESTAMPTZ,
 UNIQUE(owner_user_id,org_id,key_hash),
 CONSTRAINT user_ton_checkouts_org_owner_fk FOREIGN KEY(org_id,owner_user_id) REFERENCES organizations(id,owner_id) ON DELETE RESTRICT,
 CONSTRAINT user_ton_checkouts_wallet_owner_fk FOREIGN KEY(wallet_id,owner_user_id) REFERENCES user_ton_wallets(id,user_id) ON DELETE RESTRICT,
 CONSTRAINT user_ton_checkouts_invoice_context_fk FOREIGN KEY(invoice_id,org_id,owner_user_id) REFERENCES ton_invoices(id,org_id,owner_user_id) ON DELETE RESTRICT,
 CHECK((send_attempt_id IS NULL)=(send_claimed_at IS NULL)),
 CHECK(client_report IS NULL OR send_attempt_id IS NOT NULL),
 CHECK((client_report IS NULL)=(client_reported_at IS NULL))
);
CREATE INDEX user_ton_checkouts_owner_time ON user_ton_checkouts(owner_user_id,created_at);

CREATE FUNCTION aiag_ton_checkout_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TON_CHECKOUT_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-ARRAY['send_attempt_id','send_claimed_at','client_report','client_reported_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['send_attempt_id','send_claimed_at','client_report','client_reported_at'])
 THEN RAISE EXCEPTION 'TON_CHECKOUT_IMMUTABLE'; END IF;

 IF OLD.send_attempt_id IS NULL THEN
  IF NEW.send_attempt_id IS NULL THEN
   IF NEW.send_claimed_at IS NOT NULL OR NEW.client_report IS NOT NULL OR NEW.client_reported_at IS NOT NULL THEN RAISE EXCEPTION 'TON_CHECKOUT_INVALID_TRANSITION'; END IF;
  ELSE
   IF NEW.client_report IS NOT NULL OR NEW.client_reported_at IS NOT NULL THEN RAISE EXCEPTION 'TON_CHECKOUT_INVALID_TRANSITION'; END IF;
   PERFORM 1 FROM organizations o WHERE o.id=NEW.org_id AND o.owner_id=NEW.owner_user_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'TON_CHECKOUT_INVALID_TRANSITION'; END IF;
   PERFORM 1 FROM ton_invoices i WHERE i.id=NEW.invoice_id AND i.org_id=NEW.org_id AND i.owner_user_id=NEW.owner_user_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'TON_CHECKOUT_INVALID_TRANSITION'; END IF;
   PERFORM 1 FROM user_ton_wallets w WHERE w.id=NEW.wallet_id AND w.user_id=NEW.owner_user_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'TON_CHECKOUT_INVALID_TRANSITION'; END IF;
   IF NOT EXISTS(
    SELECT 1 FROM ton_invoices i JOIN user_ton_wallets w ON w.id=NEW.wallet_id AND w.user_id=NEW.owner_user_id
    WHERE i.id=NEW.invoice_id AND i.org_id=NEW.org_id AND i.owner_user_id=NEW.owner_user_id
      AND i.status IN('pending','observed') AND i.expires_at>clock_timestamp()
      AND w.network='-3' AND w.revoked_at IS NULL AND i.expected_sender=w.address
   ) THEN RAISE EXCEPTION 'TON_CHECKOUT_INVALID_TRANSITION'; END IF;
   NEW.send_claimed_at:=clock_timestamp();
  END IF;
 ELSE
  IF NEW.send_attempt_id IS DISTINCT FROM OLD.send_attempt_id OR NEW.send_claimed_at IS DISTINCT FROM OLD.send_claimed_at THEN RAISE EXCEPTION 'TON_CHECKOUT_IMMUTABLE'; END IF;
  IF OLD.client_report IS NULL THEN
   IF NEW.client_report IS NULL THEN
    IF NEW.client_reported_at IS NOT NULL THEN RAISE EXCEPTION 'TON_CHECKOUT_INVALID_TRANSITION'; END IF;
   ELSE
    NEW.client_reported_at:=clock_timestamp();
   END IF;
  ELSIF NEW.client_report IS DISTINCT FROM OLD.client_report OR NEW.client_reported_at IS DISTINCT FROM OLD.client_reported_at THEN
   RAISE EXCEPTION 'TON_CHECKOUT_IMMUTABLE';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ton_checkout_identity_guard BEFORE UPDATE OR DELETE ON user_ton_checkouts FOR EACH ROW EXECUTE FUNCTION aiag_ton_checkout_immutable();
REVOKE EXECUTE ON FUNCTION aiag_ton_checkout_immutable() FROM PUBLIC;
COMMIT;
