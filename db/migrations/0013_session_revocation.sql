BEGIN;

CREATE FUNCTION app.revoke_membership_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF OLD.status='active' AND NEW.status='inactive' THEN
    UPDATE app.auth_sessions SET revoked_at=now()
    WHERE membership_id=NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.revoke_membership_sessions() FROM PUBLIC;
CREATE TRIGGER membership_sessions_revoked AFTER UPDATE OF status ON app.tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION app.revoke_membership_sessions();

CREATE FUNCTION app.revoke_tenant_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF OLD.status='active' AND NEW.status <> 'active' THEN
    UPDATE app.auth_sessions SET revoked_at=now()
    WHERE membership_id IN (SELECT id FROM app.tenant_memberships WHERE tenant_id=NEW.id)
      AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.revoke_tenant_sessions() FROM PUBLIC;
CREATE TRIGGER tenant_sessions_revoked AFTER UPDATE OF status ON app.tenants
  FOR EACH ROW EXECUTE FUNCTION app.revoke_tenant_sessions();

CREATE FUNCTION app.revoke_subscription_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF OLD.status='active' AND NEW.status <> 'active' THEN
    UPDATE app.auth_sessions SET revoked_at=now()
    WHERE membership_id IN (SELECT id FROM app.tenant_memberships WHERE tenant_id=NEW.tenant_id)
      AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.revoke_subscription_sessions() FROM PUBLIC;
CREATE TRIGGER subscription_sessions_revoked AFTER UPDATE OF status ON app.subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.revoke_subscription_sessions();

COMMIT;
