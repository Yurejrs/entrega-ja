BEGIN;

GRANT DELETE ON app.delivery_events TO app_worker_runtime;
CREATE POLICY worker_event_retention ON app.delivery_events FOR DELETE TO app_worker_runtime USING (true);

CREATE OR REPLACE FUNCTION app.expired_delivery_event_ids()
RETURNS TABLE(id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT e.id
  FROM app.delivery_events e
  WHERE e.occurred_at < now() - interval '365 days'
    AND NOT EXISTS (SELECT 1 FROM app.delivery_photos p WHERE p.tenant_id=e.tenant_id AND p.event_id=e.id)
$$;

REVOKE ALL ON FUNCTION app.expired_delivery_event_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expired_delivery_event_ids() TO app_worker_runtime;

COMMIT;
