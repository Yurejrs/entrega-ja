BEGIN;

GRANT INSERT ON app.audit_logs TO app_auth_runtime;
CREATE POLICY auth_audit_insert ON app.audit_logs FOR INSERT TO app_auth_runtime WITH CHECK (true);

COMMIT;
