BEGIN;

ALTER TABLE app.users
  ADD COLUMN profile_location text CHECK (profile_location IS NULL OR length(trim(profile_location)) > 0),
  ADD COLUMN profile_photo_key text CHECK (profile_photo_key IS NULL OR
    profile_photo_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$');

GRANT UPDATE (profile_location, profile_photo_key) ON app.users TO app_runtime;

COMMIT;
