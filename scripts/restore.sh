#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${RESTORE_DATABASE_URL:?Defina o banco vazio de destino}"
: "${RESTORE_FILE_STORAGE_DIR:?Defina um diretório vazio para as fotos}"
backup="$(realpath "${1:?Informe o diretório do backup}")"
for command in psql pg_restore tar sha256sum; do command -v "$command" >/dev/null; done
(cd "$backup" && sha256sum --check SHA256SUMS)
if [[ "$(psql "$RESTORE_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S')")" != 0 ]]; then
  echo 'O banco de destino deve estar vazio.' >&2
  exit 1
fi
mkdir -p "$RESTORE_FILE_STORAGE_DIR"
if [[ -n "$(ls -A "$RESTORE_FILE_STORAGE_DIR")" ]]; then
  echo 'O diretório de fotos deve estar vazio.' >&2
  exit 1
fi
psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN CREATE ROLE app_runtime NOLOGIN; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_auth_runtime') THEN CREATE ROLE app_auth_runtime NOLOGIN; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_platform_runtime') THEN CREATE ROLE app_platform_runtime NOLOGIN; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_worker_runtime') THEN CREATE ROLE app_worker_runtime NOLOGIN; END IF;
END $$;
SQL
pg_restore --exit-on-error --single-transaction --no-owner --dbname="$RESTORE_DATABASE_URL" "$backup/database.dump"
tar --extract --file="$backup/private-files.tar" --directory="$RESTORE_FILE_STORAGE_DIR" --no-same-owner
printf 'Restauração concluída. Confira os dados e configure as credenciais da aplicação antes de iniciar os serviços.\n'
