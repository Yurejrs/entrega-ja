BEGIN;

-- The API sets these three values with SET LOCAL inside each authenticated transaction.
CREATE FUNCTION app.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
CREATE FUNCTION app.current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
CREATE FUNCTION app.current_membership_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.membership_id', true), '')::uuid
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA app TO app_runtime;
GRANT SELECT ON app.tenants, app.users, app.plans, app.subscriptions TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.tenant_memberships, app.customers, app.addresses, app.deliveries,
  app.delivery_events, app.delivery_photos, app.devices, app.notification_outbox
  TO app_runtime;
GRANT SELECT, INSERT ON app.audit_logs TO app_runtime;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id(), app.current_membership_id() TO app_runtime;

ALTER TABLE app.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_own ON app.tenants FOR SELECT TO app_runtime
  USING (id = app.current_tenant_id());

ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_self ON app.users FOR SELECT TO app_runtime
  USING (id = app.current_user_id());

ALTER TABLE app.tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_read ON app.tenant_memberships FOR SELECT TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND
    (id = app.current_membership_id() OR
      current_setting('app.role', true) = 'admin'));
CREATE POLICY memberships_admin_write ON app.tenant_memberships FOR ALL TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'admin')
  WITH CHECK (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'admin');

ALTER TABLE app.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.customers FORCE ROW LEVEL SECURITY;
CREATE POLICY customers_read ON app.customers FOR SELECT TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND
    (current_setting('app.role', true) = 'admin' OR EXISTS (
      SELECT 1 FROM app.deliveries d WHERE d.tenant_id = customers.tenant_id
      AND d.customer_id = customers.id AND d.courier_membership_id = app.current_membership_id()
    )));
CREATE POLICY customers_admin_write ON app.customers FOR ALL TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'admin')
  WITH CHECK (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'admin');

ALTER TABLE app.addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY addresses_read ON app.addresses FOR SELECT TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND
    (current_setting('app.role', true) = 'admin' OR EXISTS (
      SELECT 1 FROM app.deliveries d WHERE d.tenant_id = addresses.tenant_id
      AND d.address_id = addresses.id AND d.courier_membership_id = app.current_membership_id()
    )));
CREATE POLICY addresses_admin_write ON app.addresses FOR ALL TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'admin')
  WITH CHECK (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'admin');

ALTER TABLE app.deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY deliveries_read ON app.deliveries FOR SELECT TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND
    (current_setting('app.role', true) = 'admin' OR courier_membership_id = app.current_membership_id()));
CREATE POLICY deliveries_admin_write ON app.deliveries FOR ALL TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'admin')
  WITH CHECK (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'admin');

ALTER TABLE app.delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.delivery_events FORCE ROW LEVEL SECURITY;
CREATE POLICY events_read ON app.delivery_events FOR SELECT TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND EXISTS (
    SELECT 1 FROM app.deliveries d WHERE d.tenant_id = delivery_events.tenant_id
    AND d.id = delivery_events.delivery_id
  ));
CREATE POLICY events_insert ON app.delivery_events FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = app.current_tenant_id() AND
    (current_setting('app.role', true) = 'admin' OR
      (actor_membership_id = app.current_membership_id()
       AND kind IN ('viewed', 'check_in', 'completed', 'problem', 'note')
       AND EXISTS (SELECT 1 FROM app.deliveries d WHERE d.tenant_id = delivery_events.tenant_id
         AND d.id = delivery_events.delivery_id
         AND d.courier_membership_id = app.current_membership_id()))));

ALTER TABLE app.delivery_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.delivery_photos FORCE ROW LEVEL SECURITY;
CREATE POLICY photos_read ON app.delivery_photos FOR SELECT TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND EXISTS (
    SELECT 1 FROM app.deliveries d WHERE d.tenant_id = delivery_photos.tenant_id
    AND d.id = delivery_photos.delivery_id
  ));
CREATE POLICY photos_insert ON app.delivery_photos FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = app.current_tenant_id() AND EXISTS (
    SELECT 1 FROM app.deliveries d WHERE d.tenant_id = delivery_photos.tenant_id
    AND d.id = delivery_photos.delivery_id
  ));

ALTER TABLE app.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.devices FORCE ROW LEVEL SECURITY;
CREATE POLICY devices_own ON app.devices FOR ALL TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND
    (current_setting('app.role', true) = 'admin' OR membership_id = app.current_membership_id()))
  WITH CHECK (tenant_id = app.current_tenant_id() AND
    (current_setting('app.role', true) = 'admin' OR membership_id = app.current_membership_id()));

ALTER TABLE app.notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notification_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_admin ON app.notification_outbox FOR ALL TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'admin')
  WITH CHECK (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'admin');

ALTER TABLE app.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.plans FORCE ROW LEVEL SECURITY;
CREATE POLICY plans_visible ON app.plans FOR SELECT TO app_runtime USING (active);

ALTER TABLE app.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_own ON app.subscriptions FOR SELECT TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'admin');

ALTER TABLE app.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON app.audit_logs FOR SELECT TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'admin');
CREATE POLICY audit_insert ON app.audit_logs FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = app.current_tenant_id() AND actor_user_id = app.current_user_id());

COMMIT;
