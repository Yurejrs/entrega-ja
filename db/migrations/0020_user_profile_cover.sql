BEGIN;

ALTER TABLE app.users
  ADD COLUMN profile_cover_key text CHECK (profile_cover_key IS NULL OR
    profile_cover_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$');

GRANT SELECT (profile_cover_key) ON app.users TO app_runtime;
GRANT UPDATE (profile_cover_key) ON app.users TO app_runtime;

COMMIT;
