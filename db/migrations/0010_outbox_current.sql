BEGIN;

CREATE FUNCTION app.notification_is_current(p_outbox_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.notification_outbox o
    JOIN app.deliveries d ON d.id=o.delivery_id AND d.tenant_id=o.tenant_id
    JOIN app.devices dv ON dv.id=o.device_id AND dv.tenant_id=o.tenant_id
    WHERE o.id=p_outbox_id AND o.status='processing'
      AND d.courier_membership_id=dv.membership_id
      AND d.status IN ('assigned','in_progress')
      AND dv.revoked_at IS NULL AND dv.fcm_token IS NOT NULL
  )
$$;
REVOKE ALL ON FUNCTION app.notification_is_current(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notification_is_current(uuid) TO app_worker_runtime;

COMMIT;
