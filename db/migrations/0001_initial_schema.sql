BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  legal_name text,
  cnpj varchar(14) UNIQUE CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$'),
  contact_email text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Identity is global. Memberships retain the original tenant when a user moves.
CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(trim(email)) AND position('@' in email) > 1),
  password_hash text NOT NULL,
  full_name text NOT NULL CHECK (length(trim(full_name)) > 0),
  is_platform_admin boolean NOT NULL DEFAULT false,
  mfa_enabled boolean NOT NULL DEFAULT false,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);

CREATE TABLE app.tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  user_id uuid NOT NULL REFERENCES app.users(id),
  role text NOT NULL CHECK (role IN ('admin', 'courier')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CHECK ((status = 'active' AND ended_at IS NULL) OR (status = 'inactive' AND ended_at IS NOT NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, role)
);
CREATE UNIQUE INDEX tenant_memberships_one_active_per_user
  ON app.tenant_memberships(user_id) WHERE status = 'active';
CREATE INDEX tenant_memberships_by_tenant ON app.tenant_memberships(tenant_id, role, status);

CREATE TABLE app.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  phone text,
  email text,
  notes text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX customers_by_tenant_name ON app.customers(tenant_id, name);

CREATE TABLE app.addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  label text,
  street text NOT NULL,
  number text,
  complement text,
  neighborhood text,
  city text NOT NULL,
  state varchar(2) NOT NULL,
  postal_code varchar(8),
  reference_latitude numeric(9,6) CHECK (reference_latitude BETWEEN -90 AND 90),
  reference_longitude numeric(9,6) CHECK (reference_longitude BETWEEN -180 AND 180),
  reference_updated_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((reference_latitude IS NULL) = (reference_longitude IS NULL)),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES app.customers(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, customer_id)
);
CREATE INDEX addresses_by_customer ON app.addresses(tenant_id, customer_id);

CREATE TABLE app.deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  customer_id uuid NOT NULL,
  address_id uuid NOT NULL,
  courier_membership_id uuid,
  courier_role text NOT NULL DEFAULT 'courier' CHECK (courier_role = 'courier'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'in_progress', 'completed', 'problem', 'cancelled')),
  merchandise_description text NOT NULL CHECK (length(trim(merchandise_description)) > 0),
  instructions text,
  -- Snapshot protects the delivery history from later address corrections.
  destination_snapshot jsonb NOT NULL CHECK (jsonb_typeof(destination_snapshot) = 'object'),
  scheduled_for timestamptz,
  assigned_at timestamptz,
  viewed_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES app.customers(tenant_id, id),
  FOREIGN KEY (tenant_id, address_id, customer_id) REFERENCES app.addresses(tenant_id, id, customer_id),
  FOREIGN KEY (tenant_id, courier_membership_id, courier_role)
    REFERENCES app.tenant_memberships(tenant_id, id, role),
  UNIQUE (tenant_id, id)
);
CREATE INDEX deliveries_by_status ON app.deliveries(tenant_id, status, created_at DESC);
CREATE INDEX deliveries_by_courier ON app.deliveries(tenant_id, courier_membership_id, status, created_at DESC);
CREATE INDEX deliveries_by_customer ON app.deliveries(tenant_id, customer_id, created_at DESC);

CREATE TABLE app.delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  actor_membership_id uuid,
  kind text NOT NULL CHECK (kind IN ('created', 'assigned', 'reassigned', 'viewed', 'check_in', 'completed', 'problem', 'cancelled', 'note')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  gps_accuracy_m numeric(9,2) CHECK (gps_accuracy_m >= 0),
  note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  client_operation_id uuid,
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (kind <> 'check_in' OR (latitude IS NOT NULL AND gps_accuracy_m IS NOT NULL)),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES app.deliveries(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_membership_id) REFERENCES app.tenant_memberships(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, delivery_id),
  UNIQUE (tenant_id, client_operation_id)
);
CREATE INDEX delivery_events_timeline ON app.delivery_events(tenant_id, delivery_id, occurred_at, id);

CREATE TABLE app.delivery_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  event_id uuid,
  storage_key text NOT NULL CHECK (length(trim(storage_key)) > 0),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 varchar(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES app.deliveries(tenant_id, id),
  FOREIGN KEY (tenant_id, event_id, delivery_id) REFERENCES app.delivery_events(tenant_id, id, delivery_id),
  UNIQUE (tenant_id, id),
  UNIQUE (storage_key)
);
CREATE INDEX delivery_photos_by_delivery ON app.delivery_photos(tenant_id, delivery_id);

CREATE TABLE app.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  installation_id text NOT NULL,
  fcm_token text,
  platform text NOT NULL DEFAULT 'android' CHECK (platform = 'android'),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES app.tenant_memberships(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, installation_id)
);
CREATE UNIQUE INDEX devices_active_fcm_token ON app.devices(fcm_token) WHERE fcm_token IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE app.notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  device_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('delivery_assigned', 'delivery_reassigned')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES app.deliveries(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES app.devices(tenant_id, id),
  UNIQUE (tenant_id, id)
);
CREATE INDEX notification_outbox_pending ON app.notification_outbox(available_at, id) WHERE status = 'pending';

CREATE TABLE app.plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  max_couriers integer CHECK (max_couriers > 0),
  max_users integer CHECK (max_users > 0),
  max_monthly_deliveries integer CHECK (max_monthly_deliveries > 0),
  max_storage_bytes bigint CHECK (max_storage_bytes > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  plan_id uuid NOT NULL REFERENCES app.plans(id),
  status text NOT NULL CHECK (status IN ('active', 'suspended', 'ended')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX subscriptions_one_open_per_tenant ON app.subscriptions(tenant_id) WHERE ended_at IS NULL;

CREATE TABLE app.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES app.tenants(id),
  actor_user_id uuid REFERENCES app.users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX audit_logs_by_tenant ON app.audit_logs(tenant_id, occurred_at DESC);

COMMIT;
