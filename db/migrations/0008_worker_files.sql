BEGIN;

GRANT SELECT ON app.delivery_photos TO app_worker_runtime;
CREATE POLICY worker_photo_keys ON app.delivery_photos FOR SELECT TO app_worker_runtime USING (true);

COMMIT;
