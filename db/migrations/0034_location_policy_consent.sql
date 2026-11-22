BEGIN;

CREATE TABLE app.location_policy_consents (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  membership_id uuid NOT NULL REFERENCES app.tenant_memberships(id),
  user_id uuid NOT NULL REFERENCES app.users(id),
  policy_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,membership_id)
);

ALTER TABLE app.location_policy_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.location_policy_consents FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON app.location_policy_consents TO app_runtime;
CREATE POLICY location_consent_access ON app.location_policy_consents FOR ALL TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND membership_id=app.current_membership_id())
  WITH CHECK (tenant_id=app.current_tenant_id() AND membership_id=app.current_membership_id() AND user_id=app.current_user_id());

COMMIT;
