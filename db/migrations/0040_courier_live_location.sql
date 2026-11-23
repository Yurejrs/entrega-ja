BEGIN;

CREATE TABLE app.courier_location_sharing (
  tenant_id uuid NOT NULL,
  courier_membership_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('active','inactive')),
  started_at timestamptz,
  stopped_at timestamptz,
  last_seen_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, courier_membership_id),
  FOREIGN KEY (tenant_id, courier_membership_id) REFERENCES app.tenant_memberships(tenant_id,id)
);

CREATE TABLE app.courier_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  courier_membership_id uuid NOT NULL,
  client_point_id uuid NOT NULL,
  latitude numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m numeric(9,2) NOT NULL CHECK (accuracy_m >= 0),
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_point_id),
  FOREIGN KEY (tenant_id, courier_membership_id) REFERENCES app.tenant_memberships(tenant_id,id)
);

CREATE INDEX courier_locations_latest ON app.courier_locations(tenant_id,courier_membership_id,received_at DESC);

GRANT SELECT,INSERT,UPDATE,DELETE ON app.courier_location_sharing,app.courier_locations TO app_runtime;
GRANT SELECT,DELETE ON app.courier_locations TO app_worker_runtime;

ALTER TABLE app.courier_location_sharing ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.courier_location_sharing FORCE ROW LEVEL SECURITY;
ALTER TABLE app.courier_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.courier_locations FORCE ROW LEVEL SECURITY;

CREATE POLICY courier_location_sharing_access ON app.courier_location_sharing FOR ALL TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND (current_setting('app.role',true)='admin' OR courier_membership_id=app.current_membership_id()))
  WITH CHECK (tenant_id=app.current_tenant_id() AND (current_setting('app.role',true)='admin' OR courier_membership_id=app.current_membership_id()));

CREATE POLICY courier_locations_access ON app.courier_locations FOR ALL TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND (current_setting('app.role',true)='admin' OR courier_membership_id=app.current_membership_id()))
  WITH CHECK (tenant_id=app.current_tenant_id() AND courier_membership_id=app.current_membership_id());

CREATE POLICY worker_courier_locations_retention ON app.courier_locations FOR ALL TO app_worker_runtime
  USING (true) WITH CHECK (true);

COMMIT;
