BEGIN;

INSERT INTO app.tenants(id, name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Empresa A'),
  ('00000000-0000-0000-0000-000000000002', 'Empresa B');
INSERT INTO app.users(id, email, password_hash, full_name) VALUES
  ('10000000-0000-0000-0000-000000000001', 'admin@a.test', 'test-only', 'Admin A'),
  ('10000000-0000-0000-0000-000000000002', 'courier@a.test', 'test-only', 'Entregador A'),
  ('10000000-0000-0000-0000-000000000003', 'admin@b.test', 'test-only', 'Admin B');
INSERT INTO app.tenant_memberships(id, tenant_id, user_id, role) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'admin'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'courier'),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003', 'admin');
INSERT INTO app.customers(id, tenant_id, name) VALUES
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Cliente A'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'Cliente B');
INSERT INTO app.addresses(id, tenant_id, customer_id, street, city, state) VALUES
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Rua A', 'Fortaleza', 'CE'),
  ('40000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 'Rua B', 'Fortaleza', 'CE');
INSERT INTO app.deliveries(id, tenant_id, customer_id, address_id, courier_membership_id, status, merchandise_description, destination_snapshot) VALUES
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'assigned', 'Caixa A', '{"street":"Rua A"}'),
  ('50000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', NULL, 'pending', 'Caixa A sem atribuição', '{"street":"Rua A"}'),
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', NULL, 'pending', 'Caixa B', '{"street":"Rua B"}');

DO $$ BEGIN
  BEGIN
    INSERT INTO app.deliveries(tenant_id, customer_id, address_id, merchandise_description, destination_snapshot)
    VALUES ('00000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002',
      '40000000-0000-0000-0000-000000000002', 'Inválida', '{}');
    RAISE EXCEPTION 'Cross-tenant foreign key was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

SET ROLE app_runtime;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', '10000000-0000-0000-0000-000000000002', true);
SELECT set_config('app.membership_id', '20000000-0000-0000-0000-000000000002', true);
SELECT set_config('app.role', 'courier', true);
DO $$ BEGIN
  IF (SELECT count(*) FROM app.deliveries) <> 1 THEN RAISE EXCEPTION 'Courier delivery isolation failed'; END IF;
  IF (SELECT count(*) FROM app.customers) <> 1 THEN RAISE EXCEPTION 'Courier customer isolation failed'; END IF;
  IF (SELECT count(*) FROM app.addresses) <> 1 THEN RAISE EXCEPTION 'Courier address isolation failed'; END IF;
  BEGIN
    INSERT INTO app.customers(tenant_id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Forbidden');
    RAISE EXCEPTION 'Courier inserted customer';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

RESET ROLE;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000002', true);
SELECT set_config('app.user_id', '10000000-0000-0000-0000-000000000003', true);
SELECT set_config('app.membership_id', '20000000-0000-0000-0000-000000000003', true);
SELECT set_config('app.role', 'admin', true);
SET ROLE app_runtime;
DO $$ BEGIN
  IF (SELECT count(*) FROM app.deliveries) <> 1 THEN RAISE EXCEPTION 'Admin tenant isolation failed'; END IF;
  BEGIN
    INSERT INTO app.customers(tenant_id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Forbidden');
    RAISE EXCEPTION 'Cross-tenant insert was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

ROLLBACK;
