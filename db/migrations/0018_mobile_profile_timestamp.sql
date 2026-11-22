BEGIN;

GRANT UPDATE (updated_at) ON app.users TO app_runtime;

COMMIT;
