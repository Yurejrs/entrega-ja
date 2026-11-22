-- This file must run as app_api_test, never as the schema owner.
BEGIN;
DO $$ BEGIN
  IF current_user <> 'app_api_test' OR
     (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) OR
     (SELECT relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      FROM pg_class WHERE oid = 'app.deliveries'::regclass)
    THEN RAISE EXCEPTION 'tests must use an unprivileged API login'; END IF;
  IF (SELECT count(*) FROM app.deliveries) <> 0 THEN RAISE EXCEPTION 'missing context exposed deliveries'; END IF;
  IF (SELECT count(*) FROM app.users) <> 0 THEN RAISE EXCEPTION 'missing context exposed users'; END IF;
  BEGIN
    PERFORM app.set_request_context('10000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000004');
    RAISE EXCEPTION 'inactive membership accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SELECT app.set_request_context('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002');
DO $$ BEGIN
  IF (SELECT count(*) FROM app.deliveries) <> 1 THEN RAISE EXCEPTION 'courier sees wrong deliveries'; END IF;
  IF (SELECT count(*) FROM app.customers) <> 1 THEN RAISE EXCEPTION 'courier sees wrong customers'; END IF;
  BEGIN
    INSERT INTO app.customers(tenant_id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Forbidden');
    RAISE EXCEPTION 'courier inserted customer';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('app.role', 'admin', true);
  IF (SELECT count(*) FROM app.deliveries) <> 0 THEN RAISE EXCEPTION 'forged admin context accepted'; END IF;
END $$;
ROLLBACK;

BEGIN;
SELECT app.set_request_context('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001');
DO $$ DECLARE affected integer; BEGIN
  IF (SELECT count(*) FROM app.deliveries) <> 2 THEN RAISE EXCEPTION 'admin A sees wrong deliveries'; END IF;
  UPDATE app.deliveries SET status = 'cancelled' WHERE id = '50000000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'cross-tenant update succeeded'; END IF;
  BEGIN
    INSERT INTO app.customers(tenant_id, name) VALUES ('00000000-0000-0000-0000-000000000002', 'Forbidden');
    RAISE EXCEPTION 'cross-tenant insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE app.deliveries SET courier_membership_id = '20000000-0000-0000-0000-000000000004'
      WHERE id = '50000000-0000-0000-0000-000000000003';
    RAISE EXCEPTION 'inactive courier assignment succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE app.deliveries SET courier_membership_id = '20000000-0000-0000-0000-000000000003'
      WHERE id = '50000000-0000-0000-0000-000000000003';
    RAISE EXCEPTION 'cross-tenant courier assignment succeeded';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN NULL;
  END;
END $$;

-- Offline replay is rejected by the unique tenant/client_operation_id key.
INSERT INTO app.delivery_events(tenant_id, delivery_id, actor_membership_id, kind, client_operation_id)
VALUES ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001', 'note', '70000000-0000-0000-0000-000000000001');
DO $$ BEGIN
  BEGIN
    INSERT INTO app.delivery_events(tenant_id, delivery_id, actor_membership_id, kind, client_operation_id)
    VALUES ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001', 'note', '70000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'offline replay inserted twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- A successful API transaction writes the delivery, history and outbox together.
DO $$ BEGIN
  INSERT INTO app.deliveries(id, tenant_id, customer_id, address_id, courier_membership_id,
    status, merchandise_description, destination_snapshot)
  VALUES ('50000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002', 'assigned', 'Entrega transacional', '{"street":"Rua A"}');
  INSERT INTO app.delivery_events(tenant_id, delivery_id, actor_membership_id, kind)
  VALUES ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000010',
    '20000000-0000-0000-0000-000000000001', 'assigned');
  INSERT INTO app.notification_outbox(tenant_id, delivery_id, device_id, event_type)
  VALUES ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000010',
    '60000000-0000-0000-0000-000000000001', 'delivery_assigned');
  IF (SELECT count(*) FROM app.delivery_events WHERE delivery_id = '50000000-0000-0000-0000-000000000010') <> 1
    OR (SELECT count(*) FROM app.notification_outbox WHERE delivery_id = '50000000-0000-0000-0000-000000000010') <> 1
    THEN RAISE EXCEPTION 'transaction records missing'; END IF;
END $$;

-- Reassignment leaves history and targets the new courier's device.
UPDATE app.deliveries SET courier_membership_id = '20000000-0000-0000-0000-000000000005',
  assigned_at = now() WHERE id = '50000000-0000-0000-0000-000000000001';
INSERT INTO app.delivery_events(id, tenant_id, delivery_id, actor_membership_id, kind, metadata)
VALUES ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
  'reassigned', '{"previous_membership_id":"20000000-0000-0000-0000-000000000002","new_membership_id":"20000000-0000-0000-0000-000000000005"}');
INSERT INTO app.notification_outbox(tenant_id, delivery_id, device_id, event_type)
VALUES ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000002', 'delivery_reassigned');
DO $$ BEGIN
  IF (SELECT count(*) FROM app.notification_outbox WHERE delivery_id = '50000000-0000-0000-0000-000000000001') <> 1
    THEN RAISE EXCEPTION 'reassignment notification missing'; END IF;
  BEGIN
    INSERT INTO app.notification_outbox(tenant_id, delivery_id, device_id, event_type)
    VALUES ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000001', 'delivery_reassigned');
    RAISE EXCEPTION 'old courier device accepted after reassignment';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Photo metadata can reference only an event from the same delivery.
INSERT INTO app.delivery_photos(tenant_id, delivery_id, event_id, storage_key, mime_type, byte_size, sha256)
VALUES ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
  '80000000-0000-0000-0000-000000000001', 'tests/valid-photo', 'image/jpeg', 10, repeat('a', 64));
DO $$ BEGIN
  BEGIN
    INSERT INTO app.delivery_photos(tenant_id, delivery_id, event_id, storage_key, mime_type, byte_size, sha256)
    VALUES ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000010',
      '80000000-0000-0000-0000-000000000001', 'tests/invalid-photo', 'image/jpeg', 10, repeat('b', 64));
    RAISE EXCEPTION 'photo linked to event from another delivery';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- A failed notification insert rolls back the delivery and history subtransaction.
DO $$ BEGIN
  BEGIN
    INSERT INTO app.deliveries(id, tenant_id, customer_id, address_id, courier_membership_id,
      status, merchandise_description, destination_snapshot)
    VALUES ('50000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000002', 'assigned', 'Rollback esperado', '{}');
    INSERT INTO app.delivery_events(tenant_id, delivery_id, kind)
    VALUES ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000011', 'assigned');
    INSERT INTO app.notification_outbox(tenant_id, delivery_id, device_id, event_type)
    VALUES ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000011',
      '60000000-0000-0000-0000-000000000099', 'delivery_assigned');
    RAISE EXCEPTION 'invalid notification accepted';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM app.deliveries WHERE id = '50000000-0000-0000-0000-000000000011')
    THEN RAISE EXCEPTION 'failed transaction left delivery'; END IF;
END $$;
ROLLBACK;
