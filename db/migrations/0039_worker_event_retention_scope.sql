BEGIN;

CREATE OR REPLACE FUNCTION app.purge_expired_delivery_events()
RETURNS TABLE(id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  DELETE FROM app.delivery_events e
  WHERE e.id IN (SELECT expired.id FROM app.expired_delivery_event_ids() expired)
  RETURNING e.id
$$;

REVOKE ALL ON FUNCTION app.purge_expired_delivery_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_delivery_events() TO app_worker_runtime;

COMMIT;
