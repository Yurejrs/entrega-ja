BEGIN;

CREATE TABLE app.worker_heartbeats (
  worker_name text PRIMARY KEY,
  last_tick_at timestamptz NOT NULL,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON app.worker_heartbeats TO app_runtime;
GRANT SELECT,INSERT,UPDATE ON app.worker_heartbeats TO app_worker_runtime;

COMMIT;
