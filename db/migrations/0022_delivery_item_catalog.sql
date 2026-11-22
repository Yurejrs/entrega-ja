BEGIN;

CREATE TABLE app.tenant_delivery_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  icon_key text NOT NULL CHECK (icon_key IN ('market','gas','water','box','food','medicine','document','other')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id)
);
CREATE INDEX tenant_delivery_items_active ON app.tenant_delivery_items(tenant_id,name) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX tenant_delivery_items_name_ci ON app.tenant_delivery_items(tenant_id,lower(name)) WHERE archived_at IS NULL;

CREATE TABLE app.delivery_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  catalog_item_id uuid NOT NULL,
  item_name text NOT NULL CHECK (length(trim(item_name)) BETWEEN 1 AND 100),
  icon_key text NOT NULL CHECK (icon_key IN ('market','gas','water','box','food','medicine','document','other')),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,delivery_id) REFERENCES app.deliveries(tenant_id,id),
  FOREIGN KEY (tenant_id,catalog_item_id) REFERENCES app.tenant_delivery_items(tenant_id,id)
);
CREATE INDEX delivery_items_by_delivery ON app.delivery_items(tenant_id,delivery_id,id);

ALTER TABLE app.tenant_delivery_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_delivery_items FORCE ROW LEVEL SECURITY;
ALTER TABLE app.delivery_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.delivery_items FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.tenant_delivery_items,app.delivery_items TO app_runtime;

CREATE POLICY tenant_delivery_items_admin ON app.tenant_delivery_items FOR ALL TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND current_setting('app.role',true)='admin')
  WITH CHECK (tenant_id=app.current_tenant_id() AND current_setting('app.role',true)='admin');
CREATE POLICY delivery_items_read ON app.delivery_items FOR SELECT TO app_runtime
  USING (tenant_id=app.current_tenant_id() AND
    (current_setting('app.role',true)='admin' OR EXISTS (
      SELECT 1 FROM app.deliveries d WHERE d.tenant_id=delivery_items.tenant_id
        AND d.id=delivery_items.delivery_id AND (d.courier_membership_id=app.current_membership_id() OR (d.is_claimable AND d.status='pending'))
    )));
CREATE POLICY delivery_items_admin_insert ON app.delivery_items FOR INSERT TO app_runtime
  WITH CHECK (tenant_id=app.current_tenant_id() AND current_setting('app.role',true)='admin');

COMMIT;
