BEGIN;

GRANT DELETE ON app.delivery_photos TO app_worker_runtime;
CREATE POLICY worker_photo_retention ON app.delivery_photos FOR DELETE TO app_worker_runtime USING (true);

COMMIT;
