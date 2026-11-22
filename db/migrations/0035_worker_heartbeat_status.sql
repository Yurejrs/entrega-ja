BEGIN;

ALTER TABLE app.worker_heartbeats
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','error','no_credential'));

COMMIT;
