BEGIN;

CREATE OR REPLACE FUNCTION app.courier_period_standing(p_from timestamptz,p_until timestamptz)
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
      SELECT m.id AS id,count(d.id)::bigint AS delivery_total
      FROM app.tenant_memberships m
      LEFT JOIN app.deliveries d ON d.tenant_id=m.tenant_id AND d.courier_membership_id=m.id
        AND d.status='completed' AND d.completed_at>=p_from AND d.completed_at<p_until
      WHERE m.tenant_id=v_tenant_id AND m.role='courier' AND m.status='active'
      GROUP BY m.id
    ), ranked AS (
      SELECT counts.id,counts.delivery_total,
        CASE WHEN counts.delivery_total>0 THEN rank() OVER (ORDER BY counts.delivery_total DESC) END AS courier_rank,
        count(*) OVER ()::integer AS courier_total
      FROM counts
    )
    SELECT ranked.id,ranked.delivery_total,ranked.courier_rank,ranked.courier_total
    FROM ranked WHERE ranked.id=v_membership_id;
END $$;

REVOKE ALL ON FUNCTION app.courier_period_standing(timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.courier_period_standing(timestamptz,timestamptz) TO app_runtime;

COMMIT;
