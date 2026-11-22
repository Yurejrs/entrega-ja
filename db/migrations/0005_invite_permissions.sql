BEGIN;

GRANT SELECT, INSERT ON app.auth_invites TO app_platform_runtime, app_runtime;
CREATE POLICY platform_invites_read ON app.auth_invites FOR SELECT TO app_platform_runtime USING (true);
CREATE POLICY platform_invites_insert ON app.auth_invites FOR INSERT TO app_platform_runtime WITH CHECK (purpose = 'invite');
CREATE POLICY tenant_invites_read ON app.auth_invites FOR SELECT TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'admin');
CREATE POLICY tenant_invites_insert ON app.auth_invites FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'admin'
    AND created_by_user_id = app.current_user_id() AND purpose IN ('invite', 'password_reset'));

COMMIT;
