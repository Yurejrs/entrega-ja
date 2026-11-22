BEGIN;

CREATE FUNCTION app.courier_seasonal_leaderboard(
  p_week_from timestamptz,p_week_until timestamptz,p_month_from timestamptz,p_month_until timestamptz
) RETURNS TABLE(
  membership_id uuid,full_name text,profile_photo_key text,week_completed bigint,month_completed bigint,
  week_rank bigint,month_rank bigint,week_winner boolean,month_winner boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE v_tenant_id uuid:=app.current_tenant_id();
BEGIN
  IF current_setting('app.role',true)<>'courier' OR NOT app.context_valid() THEN
    RAISE EXCEPTION 'valid courier context required' USING ERRCODE='42501';
  END IF;
  IF p_week_from IS NULL OR p_week_until<=p_week_from OR p_week_until-p_week_from>interval '8 days'
    OR p_month_from IS NULL OR p_month_until<=p_month_from OR p_month_until-p_month_from>interval '32 days' THEN
    RAISE EXCEPTION 'invalid standings period' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
    WITH totals AS (
      SELECT m.id AS member_id,u.full_name,u.profile_photo_key AS photo_key,
        count(d.id) FILTER (WHERE d.completed_at>=p_week_from AND d.completed_at<p_week_until)::bigint AS week_total,
        count(d.id) FILTER (WHERE d.completed_at>=p_month_from AND d.completed_at<p_month_until)::bigint AS month_total
      FROM app.tenant_memberships m JOIN app.users u ON u.id=m.user_id
      LEFT JOIN app.deliveries d ON d.tenant_id=v_tenant_id AND d.courier_membership_id=m.id AND d.status='completed'
        AND ((d.completed_at>=p_week_from AND d.completed_at<p_week_until) OR (d.completed_at>=p_month_from AND d.completed_at<p_month_until))
      WHERE m.tenant_id=v_tenant_id AND m.role='courier' AND m.status='active' AND u.disabled_at IS NULL
      GROUP BY m.id,u.full_name,u.profile_photo_key
    ), ranked AS (
      SELECT totals.*,
        CASE WHEN week_total>0 THEN rank() OVER (ORDER BY week_total DESC) END AS wr,
        CASE WHEN month_total>0 THEN rank() OVER (ORDER BY month_total DESC) END AS mr
      FROM totals
    )
    SELECT member_id,full_name,photo_key,week_total,month_total,wr,mr,
      coalesce(wr=1 AND week_total>0,false),coalesce(mr=1 AND month_total>0,false)
    FROM ranked ORDER BY week_total DESC,month_total DESC,lower(full_name),member_id LIMIT 100;
END $$;
REVOKE ALL ON FUNCTION app.courier_seasonal_leaderboard(timestamptz,timestamptz,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.courier_seasonal_leaderboard(timestamptz,timestamptz,timestamptz,timestamptz) TO app_runtime;

CREATE FUNCTION app.courier_profile_photo(p_membership_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE v_photo_key text;
BEGIN
  IF current_setting('app.role',true)<>'courier' OR NOT app.context_valid() THEN
    RAISE EXCEPTION 'valid courier context required' USING ERRCODE='42501';
  END IF;
  SELECT u.profile_photo_key INTO v_photo_key FROM app.tenant_memberships m
  JOIN app.users u ON u.id=m.user_id
  WHERE m.id=p_membership_id AND m.tenant_id=app.current_tenant_id()
    AND m.role='courier' AND m.status='active' AND u.disabled_at IS NULL;
  IF NOT FOUND OR v_photo_key IS NULL THEN
    RAISE EXCEPTION 'courier photo not found' USING ERRCODE='P0002';
  END IF;
  RETURN v_photo_key;
END $$;
REVOKE ALL ON FUNCTION app.courier_profile_photo(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.courier_profile_photo(uuid) TO app_runtime;

COMMIT;
