BEGIN;

CREATE POLICY courier_self_profile ON app.users FOR UPDATE TO app_runtime
  USING (id = app.current_user_id() AND current_setting('app.role', true) = 'courier')
  WITH CHECK (id = app.current_user_id() AND current_setting('app.role', true) = 'courier');

COMMIT;
