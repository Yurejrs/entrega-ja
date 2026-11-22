BEGIN;

-- This function is owned by the privileged migration role. The application role
-- remains NOBYPASSRLS. The API must authenticate the user before setting context.
CREATE FUNCTION app.context_valid() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.tenant_memberships m
    JOIN app.users u ON u.id = m.user_id
    JOIN app.tenants t ON t.id = m.tenant_id
    WHERE m.id = nullif(current_setting('app.membership_id', true), '')::uuid
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      AND m.role = current_setting('app.role', true)
      AND m.status = 'active' AND u.disabled_at IS NULL AND t.status = 'active'
  )
$$;
REVOKE ALL ON FUNCTION app.context_valid() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.context_valid() TO app_runtime;

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN app.context_valid()
    THEN nullif(current_setting('app.tenant_id', true), '')::uuid ELSE NULL END
$$;
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN app.context_valid()
    THEN nullif(current_setting('app.user_id', true), '')::uuid ELSE NULL END
$$;
CREATE OR REPLACE FUNCTION app.current_membership_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN app.context_valid()
    THEN nullif(current_setting('app.membership_id', true), '')::uuid ELSE NULL END
$$;

-- A direct SQL client can set custom GUCs. This helper checks consistency; the
-- authenticated identity still must come from the API, never request payloads.
CREATE FUNCTION app.set_request_context(p_user_id uuid, p_membership_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE v_tenant_id uuid; v_role text;
BEGIN
  SELECT m.tenant_id, m.role INTO v_tenant_id, v_role
  FROM app.tenant_memberships m
  JOIN app.users u ON u.id = m.user_id
  JOIN app.tenants t ON t.id = m.tenant_id
  WHERE m.id = p_membership_id AND m.user_id = p_user_id
    AND m.status = 'active' AND u.disabled_at IS NULL AND t.status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'inactive or mismatched membership' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('app.tenant_id', v_tenant_id::text, true);
  PERFORM set_config('app.user_id', p_user_id::text, true);
  PERFORM set_config('app.membership_id', p_membership_id::text, true);
  PERFORM set_config('app.role', v_role, true);
END $$;
REVOKE ALL ON FUNCTION app.set_request_context(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_request_context(uuid, uuid) TO app_runtime;

CREATE FUNCTION app.check_new_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF NEW.courier_membership_id IS NOT NULL AND
     (TG_OP = 'INSERT' OR NEW.courier_membership_id IS DISTINCT FROM OLD.courier_membership_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.tenant_memberships m
      WHERE m.id = NEW.courier_membership_id AND m.tenant_id = NEW.tenant_id
        AND m.role = 'courier' AND m.status = 'active'
    ) THEN RAISE EXCEPTION 'courier membership must be active in the delivery tenant'
      USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.check_new_assignment() FROM PUBLIC;
CREATE TRIGGER deliveries_active_assignment BEFORE INSERT OR UPDATE OF courier_membership_id
  ON app.deliveries FOR EACH ROW EXECUTE FUNCTION app.check_new_assignment();

CREATE FUNCTION app.check_outbox_recipient() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.deliveries d
    JOIN app.devices dv ON dv.id = NEW.device_id AND dv.tenant_id = NEW.tenant_id
    WHERE d.id = NEW.delivery_id AND d.tenant_id = NEW.tenant_id
      AND d.courier_membership_id = dv.membership_id AND dv.revoked_at IS NULL
  ) THEN RAISE EXCEPTION 'notification device does not belong to assigned courier'
    USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.check_outbox_recipient() FROM PUBLIC;
CREATE TRIGGER outbox_recipient_matches_assignment BEFORE INSERT
  ON app.notification_outbox FOR EACH ROW EXECUTE FUNCTION app.check_outbox_recipient();

-- Limit role-wide grants inherited from the initial migration.
REVOKE UPDATE, DELETE ON app.delivery_events, app.delivery_photos FROM app_runtime;

COMMIT;
