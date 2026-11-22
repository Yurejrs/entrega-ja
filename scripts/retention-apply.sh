#!/usr/bin/env bash
set -euo pipefail

: "${RETENTION_APPLY_APPROVED:?Defina RETENTION_APPLY_APPROVED=true somente após revisar o relatório}"
[[ "$RETENTION_APPLY_APPROVED" == true ]] || { echo 'A retenção exige RETENTION_APPLY_APPROVED=true.' >&2; exit 2; }
: "${RETENTION_DATABASE_URL:?Defina RETENTION_DATABASE_URL com uma credencial administrativa dedicada}"
command -v psql >/dev/null 2>&1 || { echo 'psql é obrigatório para aplicar a retenção.' >&2; exit 2; }

psql "$RETENTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL statement_timeout = '30s';

-- Primeiro remove endereços de clientes arquivados sem histórico; a FK impede
-- que clientes com entregas sejam apagados.
DELETE FROM app.addresses a
USING app.customers c
WHERE a.tenant_id=c.tenant_id AND a.customer_id=c.id
  AND c.archived_at < now() - interval '90 days'
  AND NOT EXISTS (SELECT 1 FROM app.deliveries d WHERE d.tenant_id=c.tenant_id AND d.customer_id=c.id);

DELETE FROM app.customers c
WHERE c.archived_at < now() - interval '90 days'
  AND NOT EXISTS (SELECT 1 FROM app.deliveries d WHERE d.tenant_id=c.tenant_id AND d.customer_id=c.id);

-- Com histórico, preserva o vínculo operacional e remove os principais dados
-- de contato; snapshots e eventos permanecem para auditoria contratual.
UPDATE app.customers c
SET name='Cliente arquivado ' || left(c.id::text,8), phone=NULL, email=NULL, notes=NULL, updated_at=now()
WHERE c.archived_at < now() - interval '90 days';

UPDATE app.auth_sessions s
SET revoked_at=coalesce(revoked_at,now())
FROM app.users u
WHERE u.id=s.user_id AND u.disabled_at < now() - interval '90 days';

UPDATE app.devices d
SET revoked_at=coalesce(revoked_at,now()), fcm_token=NULL
FROM app.tenant_memberships m
JOIN app.users u ON u.id=m.user_id
WHERE d.membership_id=m.id AND d.tenant_id=m.tenant_id
  AND u.disabled_at < now() - interval '90 days';

DELETE FROM app.totp_factors f
USING app.users u
WHERE u.id=f.user_id AND u.disabled_at < now() - interval '90 days';
DELETE FROM app.mfa_recovery_codes r
USING app.users u
WHERE u.id=r.user_id AND u.disabled_at < now() - interval '90 days';

UPDATE app.users u
SET email='desligado+' || u.id::text || '@invalid.local',
    full_name='Usuário desligado', password_hash='!retained-by-privacy-job',
    mfa_enabled=false, updated_at=now()
WHERE u.disabled_at < now() - interval '90 days';

COMMIT;
SQL
