BEGIN;

CREATE TABLE app.delivery_assignment_removals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,delivery_id) REFERENCES app.deliveries(tenant_id,id),
  FOREIGN KEY (tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id),
  UNIQUE (tenant_id,id)
);
CREATE INDEX assignment_removals_by_courier ON app.delivery_assignment_removals
  (tenant_id,membership_id,changed_at DESC,id);
ALTER TABLE app.delivery_assignment_removals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.delivery_assignment_removals FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON app.delivery_assignment_removals TO app_runtime;
CREATE POLICY assignment_removals_read ON app.delivery_assignment_removals FOR SELECT TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND membership_id=app.current_membership_id());
CREATE POLICY assignment_removals_admin_insert ON app.delivery_assignment_removals FOR INSERT TO app_runtime
  WITH CHECK (tenant_id=app.current_tenant_id() AND current_setting('app.role',true)='admin');

COMMIT;
