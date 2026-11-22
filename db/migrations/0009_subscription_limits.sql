BEGIN;

CREATE FUNCTION app.active_plan_limits()
RETURNS TABLE(max_couriers integer, max_users integer, max_monthly_deliveries integer,
  max_storage_bytes bigint, used_storage_bytes bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT p.max_couriers,p.max_users,p.max_monthly_deliveries,p.max_storage_bytes,
    (SELECT coalesce(sum(ph.byte_size),0)::bigint FROM app.delivery_photos ph
      WHERE ph.tenant_id=s.tenant_id)
  FROM app.subscriptions s JOIN app.plans p ON p.id=s.plan_id
  WHERE s.tenant_id=app.current_tenant_id() AND s.ended_at IS NULL
    AND s.status='active' AND p.active
$$;
REVOKE ALL ON FUNCTION app.active_plan_limits() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.active_plan_limits() TO app_runtime;

GRANT SELECT ON app.subscriptions, app.plans TO app_auth_runtime;
CREATE POLICY auth_subscriptions ON app.subscriptions FOR SELECT TO app_auth_runtime USING (true);
CREATE POLICY auth_plans ON app.plans FOR SELECT TO app_auth_runtime USING (true);

COMMIT;
