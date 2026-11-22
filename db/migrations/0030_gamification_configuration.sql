BEGIN;

-- Configuração da gamificação por empresa. Todas as tabelas são opcionais:
-- instalações existentes continuam usando os valores calculados pela API.
CREATE TABLE app.gamification_settings (
  tenant_id uuid PRIMARY KEY REFERENCES app.tenants(id),
  daily_goal integer NOT NULL DEFAULT 10 CHECK (daily_goal > 0 AND daily_goal <= 500),
  celebration_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.gamification_badges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text NOT NULL CHECK (length(trim(description)) > 0),
  target integer NOT NULL CHECK (target > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX gamification_badges_by_tenant ON app.gamification_badges(tenant_id, active, target);

CREATE TABLE app.courier_badges (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  badge_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  unlocked_at timestamptz,
  progress integer NOT NULL DEFAULT 0 CHECK (progress >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, badge_id, membership_id),
  FOREIGN KEY (tenant_id, badge_id) REFERENCES app.gamification_badges(tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES app.tenant_memberships(tenant_id, id)
);
CREATE INDEX courier_badges_by_member ON app.courier_badges(tenant_id, membership_id, unlocked_at DESC);

CREATE TABLE app.problem_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  code text NOT NULL CHECK (code ~ '^[a-z0-9_]+$'),
  label text NOT NULL CHECK (length(trim(label)) > 0),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE INDEX problem_reasons_active ON app.problem_reasons(tenant_id, active, sort_order, label);

CREATE TABLE app.gamification_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text NOT NULL DEFAULT '',
  target integer NOT NULL CHECK (target > 0),
  bonus_cents integer NOT NULL DEFAULT 0 CHECK (bonus_cents >= 0),
  starts_at date NOT NULL,
  ends_at date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at >= starts_at)
);
CREATE INDEX gamification_challenges_period ON app.gamification_challenges(tenant_id, active, starts_at, ends_at);

ALTER TABLE app.delivery_events
  ADD COLUMN IF NOT EXISTS problem_reason_id uuid;
ALTER TABLE app.delivery_events
  ADD CONSTRAINT delivery_events_problem_reason_fk
  FOREIGN KEY (tenant_id, problem_reason_id) REFERENCES app.problem_reasons(tenant_id, id);
CREATE INDEX delivery_events_problem_reason ON app.delivery_events(tenant_id, problem_reason_id, occurred_at DESC)
  WHERE problem_reason_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON app.gamification_settings, app.gamification_badges,
  app.courier_badges, app.problem_reasons, app.gamification_challenges TO app_runtime;
ALTER TABLE app.gamification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.gamification_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.gamification_badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.gamification_badges FORCE ROW LEVEL SECURITY;
ALTER TABLE app.courier_badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.courier_badges FORCE ROW LEVEL SECURITY;
ALTER TABLE app.problem_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.problem_reasons FORCE ROW LEVEL SECURITY;
ALTER TABLE app.gamification_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.gamification_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY gamification_settings_tenant ON app.gamification_settings FOR ALL TO app_runtime
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY gamification_badges_tenant ON app.gamification_badges FOR ALL TO app_runtime
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY courier_badges_tenant ON app.courier_badges FOR ALL TO app_runtime
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY problem_reasons_tenant ON app.problem_reasons FOR ALL TO app_runtime
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY gamification_challenges_tenant ON app.gamification_challenges FOR ALL TO app_runtime
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

INSERT INTO app.problem_reasons(tenant_id,code,label,sort_order)
SELECT t.id,v.code,v.label,v.sort_order
FROM app.tenants t
CROSS JOIN (VALUES
  ('customer_absent','Cliente ausente',1),
  ('address_not_found','Endereço não encontrado',2),
  ('customer_refused','Cliente recusou',3),
  ('other','Outro',4)
) AS v(code,label,sort_order)
ON CONFLICT (tenant_id,code) DO NOTHING;

COMMIT;
