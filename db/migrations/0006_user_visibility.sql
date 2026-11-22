BEGIN;

CREATE POLICY tenant_admin_users ON app.users FOR SELECT TO app_runtime
  USING (app.current_tenant_id() IS NOT NULL AND current_setting('app.role', true) = 'admin'
    AND EXISTS (SELECT 1 FROM app.tenant_memberships m
      WHERE m.user_id = users.id AND m.tenant_id = app.current_tenant_id()));

COMMIT;
