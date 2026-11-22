BEGIN;

CREATE TABLE app.delivery_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  courier_membership_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed','cancelled')),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,courier_membership_id) REFERENCES app.tenant_memberships(tenant_id,id),
  UNIQUE (tenant_id,id)
);
CREATE UNIQUE INDEX delivery_routes_one_active_per_courier ON app.delivery_routes(tenant_id,courier_membership_id) WHERE status='active';
CREATE TABLE app.delivery_route_stops (
  tenant_id uuid NOT NULL,
  route_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','completed','skipped')),
  PRIMARY KEY (tenant_id,route_id,delivery_id),
  UNIQUE (tenant_id,route_id,position),
  FOREIGN KEY (tenant_id,route_id) REFERENCES app.delivery_routes(tenant_id,id),
  FOREIGN KEY (tenant_id,delivery_id) REFERENCES app.deliveries(tenant_id,id)
);
CREATE TABLE app.delivery_route_locations (
  tenant_id uuid NOT NULL,
  route_id uuid NOT NULL,
  client_point_id uuid NOT NULL,
  courier_membership_id uuid NOT NULL,
  latitude numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m numeric(9,2) NOT NULL CHECK (accuracy_m >= 0),
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,client_point_id),
  FOREIGN KEY (tenant_id,route_id) REFERENCES app.delivery_routes(tenant_id,id),
  FOREIGN KEY (tenant_id,courier_membership_id) REFERENCES app.tenant_memberships(tenant_id,id)
);
CREATE INDEX delivery_route_locations_timeline ON app.delivery_route_locations(tenant_id,route_id,captured_at);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.delivery_routes,app.delivery_route_stops,app.delivery_route_locations TO app_runtime;
ALTER TABLE app.delivery_routes ENABLE ROW LEVEL SECURITY; ALTER TABLE app.delivery_routes FORCE ROW LEVEL SECURITY;
ALTER TABLE app.delivery_route_stops ENABLE ROW LEVEL SECURITY; ALTER TABLE app.delivery_route_stops FORCE ROW LEVEL SECURITY;
ALTER TABLE app.delivery_route_locations ENABLE ROW LEVEL SECURITY; ALTER TABLE app.delivery_route_locations FORCE ROW LEVEL SECURITY;
CREATE POLICY route_tenant_access ON app.delivery_routes FOR ALL TO app_runtime USING (tenant_id=app.current_tenant_id() AND (current_setting('app.role',true)='admin' OR courier_membership_id=app.current_membership_id())) WITH CHECK (tenant_id=app.current_tenant_id() AND (current_setting('app.role',true)='admin' OR courier_membership_id=app.current_membership_id()));
CREATE POLICY route_stop_access ON app.delivery_route_stops FOR ALL TO app_runtime USING (delivery_route_stops.tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.delivery_routes r WHERE r.tenant_id=delivery_route_stops.tenant_id AND r.id=delivery_route_stops.route_id AND (current_setting('app.role',true)='admin' OR r.courier_membership_id=app.current_membership_id()))) WITH CHECK (delivery_route_stops.tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.delivery_routes r WHERE r.tenant_id=delivery_route_stops.tenant_id AND r.id=delivery_route_stops.route_id AND (current_setting('app.role',true)='admin' OR r.courier_membership_id=app.current_membership_id())));
CREATE POLICY route_location_access ON app.delivery_route_locations FOR ALL TO app_runtime USING (delivery_route_locations.tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.delivery_routes r WHERE r.tenant_id=delivery_route_locations.tenant_id AND r.id=delivery_route_locations.route_id AND (current_setting('app.role',true)='admin' OR r.courier_membership_id=app.current_membership_id()))) WITH CHECK (delivery_route_locations.tenant_id=app.current_tenant_id() AND courier_membership_id=app.current_membership_id() AND EXISTS(SELECT 1 FROM app.delivery_routes r WHERE r.tenant_id=delivery_route_locations.tenant_id AND r.id=delivery_route_locations.route_id AND r.courier_membership_id=app.current_membership_id() AND r.status='active'));
GRANT SELECT,DELETE ON app.delivery_route_locations TO app_worker_runtime;
CREATE POLICY worker_location_retention ON app.delivery_route_locations FOR ALL TO app_worker_runtime USING (true) WITH CHECK (true);
CREATE OR REPLACE FUNCTION app.check_outbox_recipient() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.deliveries d JOIN app.devices dv ON dv.id=NEW.device_id AND dv.tenant_id=NEW.tenant_id WHERE d.id=NEW.delivery_id AND d.tenant_id=NEW.tenant_id AND dv.revoked_at IS NULL AND ((NEW.event_type='delivery_available' AND d.is_claimable AND d.status='pending' AND d.courier_membership_id IS NULL) OR (NEW.event_type<>'delivery_available' AND d.courier_membership_id=dv.membership_id))) THEN RAISE EXCEPTION 'notification device does not match delivery recipient' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.check_outbox_recipient() FROM PUBLIC;
ALTER TABLE app.notification_outbox DROP CONSTRAINT notification_outbox_event_type_check;
ALTER TABLE app.notification_outbox ADD CONSTRAINT notification_outbox_event_type_check CHECK(event_type IN ('delivery_assigned','delivery_reassigned','delivery_available'));
CREATE OR REPLACE FUNCTION app.notification_is_current(p_outbox_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.notification_outbox o JOIN app.deliveries d ON d.id=o.delivery_id AND d.tenant_id=o.tenant_id JOIN app.devices dv ON dv.id=o.device_id AND dv.tenant_id=o.tenant_id WHERE o.id=p_outbox_id AND o.status='processing' AND dv.revoked_at IS NULL AND dv.fcm_token IS NOT NULL AND ((o.event_type='delivery_available' AND d.is_claimable AND d.status='pending' AND d.courier_membership_id IS NULL) OR (o.event_type<>'delivery_available' AND d.courier_membership_id=dv.membership_id AND d.status IN ('assigned','in_progress'))))
$$;

COMMIT;
