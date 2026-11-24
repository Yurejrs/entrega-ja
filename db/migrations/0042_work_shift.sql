BEGIN;
ALTER TABLE app.courier_location_sharing ADD COLUMN shift_id uuid;
UPDATE app.courier_location_sharing SET status='inactive',stopped_at=now(),updated_at=now() WHERE status='active';
COMMIT;
