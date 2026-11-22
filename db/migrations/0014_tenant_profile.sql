BEGIN;

GRANT UPDATE (full_name) ON app.users TO app_runtime;
CREATE POLICY tenant_admin_user_profile ON app.users FOR UPDATE TO app_runtime
  USING (app.current_tenant_id() IS NOT NULL AND current_setting('app.role', true)='admin'
    AND EXISTS (SELECT 1 FROM app.tenant_memberships m
      WHERE m.user_id=users.id AND m.tenant_id=app.current_tenant_id()))
  WITH CHECK (app.current_tenant_id() IS NOT NULL AND current_setting('app.role', true)='admin'
    AND EXISTS (SELECT 1 FROM app.tenant_memberships m
      WHERE m.user_id=users.id AND m.tenant_id=app.current_tenant_id()));

GRANT UPDATE (contact_email, updated_at) ON app.tenants TO app_runtime;
CREATE POLICY tenant_admin_contact ON app.tenants FOR UPDATE TO app_runtime
  USING (id=app.current_tenant_id() AND current_setting('app.role', true)='admin')
  WITH CHECK (id=app.current_tenant_id() AND current_setting('app.role', true)='admin');

COMMIT;
