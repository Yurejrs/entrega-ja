BEGIN;

CREATE FUNCTION app.supersede_delivery_available_notifications(p_delivery_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
  IF app.current_tenant_id() IS NULL OR current_setting('app.role',true)<>'courier'
     OR NOT EXISTS (
       SELECT 1 FROM app.deliveries d
        WHERE d.id=p_delivery_id AND d.tenant_id=app.current_tenant_id()
          AND d.courier_membership_id=app.current_membership_id()
          AND d.status='assigned' AND NOT d.is_claimable
     ) THEN
    RAISE EXCEPTION 'only the assigned courier can invalidate availability notifications' USING ERRCODE='42501';
  END IF;
  UPDATE app.notification_outbox
     SET status='failed',last_error='superseded',processed_at=now()
   WHERE delivery_id=p_delivery_id AND tenant_id=app.current_tenant_id()
     AND event_type='delivery_available' AND status IN ('pending','processing');
END $$;
REVOKE ALL ON FUNCTION app.supersede_delivery_available_notifications(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.supersede_delivery_available_notifications(uuid) TO app_runtime;

COMMIT;
