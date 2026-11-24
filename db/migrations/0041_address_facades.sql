BEGIN;

CREATE TABLE app.address_facades (
  tenant_id uuid NOT NULL,
  address_id uuid NOT NULL,
  first_delivery_id uuid,
  requested boolean NOT NULL DEFAULT false,
  image bytea,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (tenant_id,address_id),
  FOREIGN KEY (tenant_id,address_id) REFERENCES app.addresses(tenant_id,id) ON DELETE CASCADE
);

INSERT INTO app.address_facades (tenant_id,address_id,first_delivery_id)
SELECT DISTINCT ON (tenant_id,address_id) tenant_id,address_id,id FROM app.deliveries
WHERE address_id IS NOT NULL AND status <> 'cancelled'
ORDER BY tenant_id,address_id,created_at,id;

CREATE FUNCTION app.initialize_address_facade() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  INSERT INTO app.address_facades(tenant_id,address_id,first_delivery_id)
    VALUES(NEW.tenant_id,NEW.address_id,NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER initialize_address_facade AFTER INSERT ON app.deliveries
  FOR EACH ROW WHEN (NEW.address_id IS NOT NULL) EXECUTE FUNCTION app.initialize_address_facade();

ALTER TABLE app.address_facades ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.address_facades FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON app.address_facades TO app_runtime;
CREATE POLICY manage_facades ON app.address_facades TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND current_setting('app.role',true)='admin');
CREATE POLICY courier_facades ON app.address_facades FOR SELECT TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND EXISTS (SELECT 1 FROM app.deliveries d
    WHERE d.address_id=address_facades.address_id AND d.courier_membership_id=app.current_membership_id()));
CREATE POLICY capture_facades ON app.address_facades FOR UPDATE TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND EXISTS (SELECT 1 FROM app.deliveries d
    WHERE d.address_id=address_facades.address_id AND d.courier_membership_id=app.current_membership_id()
    AND d.status IN ('assigned','in_progress','problem') AND (requested OR (image IS NULL AND first_delivery_id=d.id))))
  WITH CHECK (tenant_id=app.current_tenant_id() AND NOT requested AND image IS NOT NULL);
COMMIT;
