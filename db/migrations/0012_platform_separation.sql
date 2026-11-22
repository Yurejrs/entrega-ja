BEGIN;

CREATE FUNCTION app.prevent_platform_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.users u WHERE u.id=NEW.user_id AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform administrators cannot have tenant memberships' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.prevent_platform_membership() FROM PUBLIC;
CREATE TRIGGER memberships_no_platform_user BEFORE INSERT OR UPDATE OF user_id
  ON app.tenant_memberships FOR EACH ROW EXECUTE FUNCTION app.prevent_platform_membership();

CREATE FUNCTION app.prevent_promoting_member() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF NEW.is_platform_admin AND NOT OLD.is_platform_admin AND
    EXISTS (SELECT 1 FROM app.tenant_memberships m WHERE m.user_id=NEW.id) THEN
    RAISE EXCEPTION 'tenant members cannot become platform administrators' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.prevent_promoting_member() FROM PUBLIC;
CREATE TRIGGER users_no_member_promotion BEFORE UPDATE OF is_platform_admin
  ON app.users FOR EACH ROW EXECUTE FUNCTION app.prevent_promoting_member();

COMMIT;
