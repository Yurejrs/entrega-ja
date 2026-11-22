BEGIN;

CREATE OR REPLACE FUNCTION app.guard_courier_delivery_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_self_claim boolean;
BEGIN
  IF current_setting('app.role', true) = 'courier' AND app.context_valid() THEN
    v_self_claim := OLD.courier_membership_id IS NULL AND OLD.is_claimable AND OLD.status='pending'
      AND NEW.courier_membership_id=app.current_membership_id() AND NOT NEW.is_claimable
      AND NEW.status='assigned' AND NEW.assigned_at IS NOT NULL;
    IF v_self_claim THEN
      IF (to_jsonb(NEW) - ARRAY['courier_membership_id','is_claimable','assigned_at','status','updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['courier_membership_id','is_claimable','assigned_at','status','updated_at']) THEN
        RAISE EXCEPTION 'courier may only claim an available delivery' USING ERRCODE = '42501';
      END IF;
    ELSIF (to_jsonb(NEW) - ARRAY['status','viewed_at','completed_at','updated_at']) IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['status','viewed_at','completed_at','updated_at']) THEN
      RAISE EXCEPTION 'courier may only update delivery progress' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT v_self_claim AND NOT
      ((OLD.status = 'assigned' AND NEW.status IN ('in_progress','problem')) OR
       (OLD.status IN ('in_progress','problem') AND NEW.status IN ('completed','problem'))) THEN
      RAISE EXCEPTION 'invalid courier delivery transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.completed_at IS DISTINCT FROM OLD.completed_at AND NEW.status <> 'completed' THEN
      RAISE EXCEPTION 'completed_at requires completed status' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMIT;
