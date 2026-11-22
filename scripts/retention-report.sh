#!/usr/bin/env bash
set -euo pipefail

command -v psql >/dev/null 2>&1 || { echo 'psql é obrigatório para gerar o relatório de retenção.' >&2; exit 2; }
: "${RETENTION_DATABASE_URL:?Defina RETENTION_DATABASE_URL com uma credencial somente leitura}"

psql "$RETENTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
\pset pager off
\pset format aligned
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT 'clientes arquivados sem entregas' AS categoria, count(*) AS quantidade
FROM app.customers c
WHERE c.archived_at < now() - interval '90 days'
  AND NOT EXISTS (SELECT 1 FROM app.deliveries d WHERE d.tenant_id=c.tenant_id AND d.customer_id=c.id)
UNION ALL
SELECT 'clientes arquivados com histórico', count(*)
FROM app.customers c
WHERE c.archived_at < now() - interval '90 days'
  AND EXISTS (SELECT 1 FROM app.deliveries d WHERE d.tenant_id=c.tenant_id AND d.customer_id=c.id)
UNION ALL
SELECT 'usuários desligados', count(*)
FROM app.users u
WHERE u.disabled_at < now() - interval '90 days'
UNION ALL
SELECT 'sessões de usuários desligados', count(*)
FROM app.auth_sessions s
JOIN app.users u ON u.id=s.user_id
WHERE u.disabled_at < now() - interval '90 days'
  AND s.revoked_at IS NULL;
ROLLBACK;
SQL
