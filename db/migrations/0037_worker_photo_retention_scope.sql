BEGIN;

CREATE OR REPLACE FUNCTION app.expired_delivery_photo_keys()
RETURNS TABLE(storage_key text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT p.storage_key
  FROM app.delivery_photos p
  JOIN app.deliveries d ON d.tenant_id=p.tenant_id AND d.id=p.delivery_id
  WHERE d.status IN ('completed','cancelled')
    AND coalesce(d.completed_at,d.cancelled_at,d.updated_at) < now() - interval '180 days'
$$;

REVOKE ALL ON FUNCTION app.expired_delivery_photo_keys() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expired_delivery_photo_keys() TO app_worker_runtime;

COMMIT;
