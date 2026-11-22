BEGIN;

CREATE POLICY deliveries_courier_update ON app.deliveries FOR UPDATE TO app_runtime
  USING (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'courier'
    AND courier_membership_id = app.current_membership_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND current_setting('app.role', true) = 'courier'
    AND courier_membership_id = app.current_membership_id());

CREATE FUNCTION app.guard_courier_delivery_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF current_setting('app.role', true) = 'courier' AND app.context_valid() THEN
    IF (to_jsonb(NEW) - ARRAY['status','viewed_at','completed_at','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','viewed_at','completed_at','updated_at']) THEN
      RAISE EXCEPTION 'courier may only update delivery progress' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT
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
REVOKE ALL ON FUNCTION app.guard_courier_delivery_update() FROM PUBLIC;
CREATE TRIGGER courier_delivery_update_guard BEFORE UPDATE ON app.deliveries
  FOR EACH ROW EXECUTE FUNCTION app.guard_courier_delivery_update();

COMMIT;
