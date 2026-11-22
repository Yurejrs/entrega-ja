BEGIN;

CREATE FUNCTION app.courier_period_standing(p_from timestamptz,p_until timestamptz)
RETURNS TABLE(membership_id uuid,completed_count bigint,standing bigint,total_couriers integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE
  v_tenant_id uuid := app.current_tenant_id();
  v_membership_id uuid := app.current_membership_id();
BEGIN
  IF current_setting('app.role',true)<>'courier' OR NOT app.context_valid() THEN
    RAISE EXCEPTION 'valid courier context required' USING ERRCODE='42501';
  END IF;
  IF p_from IS NULL OR p_until IS NULL OR p_until<=p_from OR p_until-p_from>interval '32 days' THEN
    RAISE EXCEPTION 'invalid standings period' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
    WITH counts AS (
      SELECT m.id AS id,count(d.id)::bigint AS completed_count
      FROM app.tenant_memberships m
      LEFT JOIN app.deliveries d ON d.tenant_id=m.tenant_id AND d.courier_membership_id=m.id
        AND d.status='completed' AND d.completed_at>=p_from AND d.completed_at<p_until
      WHERE m.tenant_id=v_tenant_id AND m.role='courier' AND m.status='active'
      GROUP BY m.id
    ), ranked AS (
      SELECT id,completed_count,
        CASE WHEN completed_count>0 THEN rank() OVER (ORDER BY completed_count DESC) END AS standing,
        count(*) OVER ()::integer AS total_couriers
      FROM counts
    )
    SELECT r.id,r.completed_count,r.standing,r.total_couriers
    FROM ranked r WHERE r.id=v_membership_id;
END $$;
REVOKE ALL ON FUNCTION app.courier_period_standing(timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.courier_period_standing(timestamptz,timestamptz) TO app_runtime;

COMMIT;
