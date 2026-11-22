BEGIN;

ALTER TABLE app.deliveries
  ADD COLUMN IF NOT EXISTS estimated_earnings_cents integer
  CHECK (estimated_earnings_cents IS NULL OR estimated_earnings_cents >= 0);

CREATE INDEX IF NOT EXISTS deliveries_by_courier_earnings
  ON app.deliveries(tenant_id, courier_membership_id, completed_at DESC)
  WHERE estimated_earnings_cents IS NOT NULL;

COMMIT;
