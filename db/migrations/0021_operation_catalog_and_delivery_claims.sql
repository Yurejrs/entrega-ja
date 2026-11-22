BEGIN;

ALTER TABLE app.deliveries
  ADD COLUMN is_claimable boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT claimable_delivery_unassigned
    CHECK (NOT is_claimable OR courier_membership_id IS NULL);

CREATE TABLE app.tenant_operating_areas (
  tenant_id uuid PRIMARY KEY REFERENCES app.tenants(id),
  location_query text NOT NULL CHECK (length(trim(location_query)) > 0),
  center_latitude numeric(9,6) NOT NULL CHECK (center_latitude BETWEEN -90 AND 90),
  center_longitude numeric(9,6) NOT NULL CHECK (center_longitude BETWEEN -180 AND 180),
  radius_m integer NOT NULL CHECK (radius_m BETWEEN 500 AND 5000),
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.tenant_localities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  source_element text NOT NULL,
  category text NOT NULL CHECK (category IN ('street','neighborhood','locality')),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  imported_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  UNIQUE (tenant_id, source_element)
);
CREATE INDEX tenant_localities_search ON app.tenant_localities(tenant_id, category, lower(name));

ALTER TABLE app.tenant_operating_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_operating_areas FORCE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_localities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_localities FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.tenant_operating_areas, app.tenant_localities TO app_runtime;
CREATE POLICY operating_area_admin ON app.tenant_operating_areas FOR ALL TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND current_setting('app.role',true)='admin')
  WITH CHECK (tenant_id=app.current_tenant_id() AND current_setting('app.role',true)='admin');
CREATE POLICY locality_catalog_admin ON app.tenant_localities FOR ALL TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND current_setting('app.role',true)='admin')
  WITH CHECK (tenant_id=app.current_tenant_id() AND current_setting('app.role',true)='admin');

DROP POLICY customers_read ON app.customers;
CREATE POLICY customers_read ON app.customers FOR SELECT TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND
    (current_setting('app.role',true)='admin' OR EXISTS (
      SELECT 1 FROM app.deliveries d WHERE d.tenant_id=customers.tenant_id
        AND d.customer_id=customers.id
        AND (d.courier_membership_id=app.current_membership_id() OR
          (d.is_claimable AND d.status='pending'))
    )));

DROP POLICY addresses_read ON app.addresses;
CREATE POLICY addresses_read ON app.addresses FOR SELECT TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND
    (current_setting('app.role',true)='admin' OR EXISTS (
      SELECT 1 FROM app.deliveries d WHERE d.tenant_id=addresses.tenant_id
        AND d.address_id=addresses.id
        AND (d.courier_membership_id=app.current_membership_id() OR
          (d.is_claimable AND d.status='pending'))
    )));

DROP POLICY deliveries_read ON app.deliveries;
CREATE POLICY deliveries_read ON app.deliveries FOR SELECT TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND
    (current_setting('app.role',true)='admin' OR
      courier_membership_id=app.current_membership_id() OR
      (is_claimable AND status='pending')));

DROP POLICY deliveries_courier_update ON app.deliveries;
CREATE POLICY deliveries_courier_update ON app.deliveries FOR UPDATE TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND current_setting('app.role',true)='courier'
    AND (courier_membership_id=app.current_membership_id() OR
      (courier_membership_id IS NULL AND is_claimable AND status='pending')))
  WITH CHECK (tenant_id=app.current_tenant_id() AND current_setting('app.role',true)='courier'
    AND courier_membership_id=app.current_membership_id() AND NOT is_claimable);

CREATE OR REPLACE FUNCTION app.guard_courier_delivery_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_self_claim boolean;
BEGIN
  IF current_setting('app.role', true) = 'courier' AND app.context_valid() THEN
    v_self_claim := OLD.courier_membership_id IS NULL AND OLD.is_claimable AND OLD.status='pending'
      AND NEW.courier_membership_id=app.current_membership_id() AND NOT NEW.is_claimable
      AND NEW.status='assigned' AND NEW.assigned_at IS NOT NULL;
    IF v_self_claim THEN
      IF (to_jsonb(NEW) - ARRAY['courier_membership_id','is_claimable','assigned_at','status','updated_at'])
        IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['courier_membership_id','is_claimable','assigned_at','status','updated_at']) THEN
        RAISE EXCEPTION 'courier may only claim an available delivery' USING ERRCODE = '42501';
      END IF;
    ELSIF (to_jsonb(NEW) - ARRAY['status','viewed_at','completed_at','updated_at']) IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['status','viewed_at','completed_at','updated_at']) THEN
      RAISE EXCEPTION 'courier may only update delivery progress' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT v_self_claim AND NOT
      ((OLD.status = 'assigned' AND NEW.status IN ('in_progress','problem')) OR
       (OLD.status = 'in_progress' AND NEW.status IN ('completed','problem'))) THEN
      RAISE EXCEPTION 'invalid courier delivery transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.completed_at IS DISTINCT FROM OLD.completed_at AND NEW.status <> 'completed' THEN
      RAISE EXCEPTION 'completed_at requires completed status' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP POLICY events_insert ON app.delivery_events;
CREATE POLICY events_insert ON app.delivery_events FOR INSERT TO app_runtime
  WITH CHECK (tenant_id=app.current_tenant_id() AND
    (current_setting('app.role',true)='admin' OR
      (actor_membership_id=app.current_membership_id() AND
        ((kind IN ('viewed','check_in','completed','problem','note') AND EXISTS (
          SELECT 1 FROM app.deliveries d WHERE d.tenant_id=delivery_events.tenant_id
            AND d.id=delivery_events.delivery_id AND d.courier_membership_id=app.current_membership_id()
        )) OR
        (kind='assigned' AND metadata->>'self_claimed'='true' AND EXISTS (
          SELECT 1 FROM app.deliveries d WHERE d.tenant_id=delivery_events.tenant_id
            AND d.id=delivery_events.delivery_id AND d.courier_membership_id=app.current_membership_id()
            AND NOT d.is_claimable AND d.status='assigned'
        ))))));

COMMIT;
