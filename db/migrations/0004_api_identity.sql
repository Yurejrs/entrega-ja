BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth_runtime') THEN
    CREATE ROLE app_auth_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_platform_runtime') THEN
    CREATE ROLE app_platform_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker_runtime') THEN
    CREATE ROLE app_worker_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA app TO app_auth_runtime, app_platform_runtime, app_worker_runtime;

CREATE TABLE app.auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(id),
  membership_id uuid REFERENCES app.tenant_memberships(id),
  scope text NOT NULL CHECK (scope IN ('platform', 'tenant')),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash char(64) CHECK (csrf_hash IS NULL OR csrf_hash ~ '^[0-9a-f]{64}$'),
  mfa_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  CHECK ((scope = 'tenant' AND membership_id IS NOT NULL) OR
         (scope = 'platform' AND membership_id IS NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_by_user ON app.auth_sessions(user_id, expires_at DESC);

CREATE TABLE app.auth_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  purpose text NOT NULL CHECK (purpose IN ('invite', 'password_reset')),
  email text NOT NULL,
  tenant_id uuid REFERENCES app.tenants(id),
  tenant_role text CHECK (tenant_role IN ('admin', 'courier')),
  created_by_user_id uuid REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (purpose = 'password_reset' OR (tenant_id IS NOT NULL AND tenant_role IS NOT NULL))
);
CREATE INDEX auth_invites_by_email ON app.auth_invites(email, created_at DESC);

CREATE TABLE app.totp_factors (
  user_id uuid PRIMARY KEY REFERENCES app.users(id),
  encrypted_secret text NOT NULL,
  enabled_at timestamptz,
  last_used_step bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.mfa_recovery_codes (
  user_id uuid NOT NULL REFERENCES app.users(id),
  code_hash char(64) NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  used_at timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

ALTER TABLE app.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.auth_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.auth_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.auth_invites FORCE ROW LEVEL SECURITY;
ALTER TABLE app.totp_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.totp_factors FORCE ROW LEVEL SECURITY;
ALTER TABLE app.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mfa_recovery_codes FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON app.users, app.tenant_memberships, app.auth_sessions,
  app.auth_invites, app.totp_factors, app.mfa_recovery_codes TO app_auth_runtime;
GRANT SELECT ON app.tenants TO app_auth_runtime;
CREATE POLICY auth_users ON app.users FOR ALL TO app_auth_runtime USING (true) WITH CHECK (true);
CREATE POLICY auth_memberships ON app.tenant_memberships FOR ALL TO app_auth_runtime USING (true) WITH CHECK (true);
CREATE POLICY auth_tenants ON app.tenants FOR SELECT TO app_auth_runtime USING (true);
CREATE POLICY auth_sessions ON app.auth_sessions FOR ALL TO app_auth_runtime USING (true) WITH CHECK (true);
CREATE POLICY auth_invites ON app.auth_invites FOR ALL TO app_auth_runtime USING (true) WITH CHECK (true);
CREATE POLICY auth_totp ON app.totp_factors FOR ALL TO app_auth_runtime USING (true) WITH CHECK (true);
CREATE POLICY auth_recovery ON app.mfa_recovery_codes FOR ALL TO app_auth_runtime USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON app.tenants, app.plans, app.subscriptions TO app_platform_runtime;
GRANT SELECT, INSERT ON app.audit_logs TO app_platform_runtime;
CREATE POLICY platform_tenants ON app.tenants FOR ALL TO app_platform_runtime USING (true) WITH CHECK (true);
CREATE POLICY platform_plans ON app.plans FOR ALL TO app_platform_runtime USING (true) WITH CHECK (true);
CREATE POLICY platform_subscriptions ON app.subscriptions FOR ALL TO app_platform_runtime USING (true) WITH CHECK (true);
CREATE POLICY platform_audit_read ON app.audit_logs FOR SELECT TO app_platform_runtime USING (true);
CREATE POLICY platform_audit_insert ON app.audit_logs FOR INSERT TO app_platform_runtime WITH CHECK (true);

GRANT SELECT, UPDATE ON app.notification_outbox TO app_worker_runtime;
GRANT SELECT, UPDATE ON app.devices TO app_worker_runtime;
CREATE POLICY worker_outbox ON app.notification_outbox FOR ALL TO app_worker_runtime USING (true) WITH CHECK (true);
CREATE POLICY worker_devices ON app.devices FOR ALL TO app_worker_runtime USING (true) WITH CHECK (true);

CREATE FUNCTION app.platform_usage_summary()
RETURNS TABLE(tenant_id uuid, total_deliveries bigint, monthly_deliveries bigint, total_photo_bytes bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT t.id,
    (SELECT count(*) FROM app.deliveries d WHERE d.tenant_id = t.id),
    (SELECT count(*) FROM app.deliveries d WHERE d.tenant_id = t.id
      AND d.created_at >= date_trunc('month', now())),
    (SELECT coalesce(sum(p.byte_size), 0) FROM app.delivery_photos p WHERE p.tenant_id = t.id)
  FROM app.tenants t
$$;
REVOKE ALL ON FUNCTION app.platform_usage_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_usage_summary() TO app_platform_runtime;

-- The operational role has no reason to read its own password hash.
REVOKE SELECT ON app.users FROM app_runtime;
GRANT SELECT (id, email, full_name, is_platform_admin, mfa_enabled, disabled_at,
  created_at, updated_at) ON app.users TO app_runtime;

COMMIT;
