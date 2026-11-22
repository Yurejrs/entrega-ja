BEGIN;

GRANT SELECT (profile_location, profile_photo_key) ON app.users TO app_runtime;

COMMIT;
