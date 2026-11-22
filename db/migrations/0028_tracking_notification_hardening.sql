BEGIN;

-- Reconcile the initially applied 0027 schema and make the current form safe
-- for both existing databases and clean installations where the final 0027 ran.
GRANT SELECT,DELETE ON app.delivery_route_locations TO app_worker_runtime;
DROP POLICY IF EXISTS worker_location_retention ON app.delivery_route_locations;
CREATE POLICY worker_location_retention ON app.delivery_route_locations
  FOR DELETE TO app_worker_runtime USING (true);

CREATE OR REPLACE FUNCTION app.check_outbox_recipient() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM app.deliveries d
      JOIN app.devices dv ON dv.id=NEW.device_id AND dv.tenant_id=NEW.tenant_id
     WHERE d.id=NEW.delivery_id AND d.tenant_id=NEW.tenant_id
       AND dv.revoked_at IS NULL
       AND ((NEW.event_type='delivery_available' AND d.is_claimable AND d.status='pending' AND d.courier_membership_id IS NULL)
         OR (NEW.event_type<>'delivery_available' AND d.courier_membership_id=dv.membership_id))
  ) THEN
    RAISE EXCEPTION 'notification device does not match delivery recipient' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.check_outbox_recipient() FROM PUBLIC;

ALTER TABLE app.notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_event_type_check;
ALTER TABLE app.notification_outbox ADD CONSTRAINT notification_outbox_event_type_check
  CHECK(event_type IN ('delivery_assigned','delivery_reassigned','delivery_available'));

CREATE OR REPLACE FUNCTION app.notification_is_current(p_outbox_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
  SELECT EXISTS (
    SELECT 1
      FROM app.notification_outbox o
      JOIN app.deliveries d ON d.id=o.delivery_id AND d.tenant_id=o.tenant_id
      JOIN app.devices dv ON dv.id=o.device_id AND dv.tenant_id=o.tenant_id
     WHERE o.id=p_outbox_id AND o.status='processing'
       AND dv.revoked_at IS NULL AND dv.fcm_token IS NOT NULL
       AND ((o.event_type='delivery_available' AND d.is_claimable AND d.status='pending' AND d.courier_membership_id IS NULL)
         OR (o.event_type<>'delivery_available' AND d.courier_membership_id=dv.membership_id AND d.status IN ('assigned','in_progress')))
  )
$$;

COMMIT;
