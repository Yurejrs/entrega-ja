#!/usr/bin/env bash
set -euo pipefail

db_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
container_name="${ENTREGAS_DB_CONTAINER:-entregas-postgres-dev}"
database_name="${ENTREGAS_DB_NAME:-entregas_dev}"
database_password="${ENTREGAS_DB_PASSWORD:-local-dev-only}"
host_port="${ENTREGAS_DB_PORT:-55432}"
container_cli="${CONTAINER_CLI:-}"
if [[ -z "$container_cli" ]]; then
  if command -v podman >/dev/null 2>&1; then container_cli=podman
  else container_cli=docker; fi
fi

psql_admin() {
  "$container_cli" exec -i "$container_name" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$database_name" "$@"
}

case "${1:-}" in
  up)
    if "$container_cli" container inspect "$container_name" >/dev/null 2>&1; then
      "$container_cli" start "$container_name" >/dev/null || true
    else
      "$container_cli" run -d --rm --name "$container_name" \
        -e POSTGRES_PASSWORD="$database_password" -e POSTGRES_DB="$database_name" \
        -v "${container_name}-data:/var/lib/postgresql/data" \
        -p "127.0.0.1:${host_port}:5432" docker.io/library/postgres:17-alpine >/dev/null
    fi
    for attempt in {1..30}; do
      if "$container_cli" exec "$container_name" psql -X -q -U postgres -d "$database_name" -c 'SELECT 1' >/dev/null 2>&1; then
        echo "PostgreSQL pronto em 127.0.0.1:${host_port}"
        exit 0
      fi
      sleep 1
    done
    echo "PostgreSQL não ficou pronto" >&2
    exit 1
    ;;
  migrate)
    psql_admin -q -c 'CREATE TABLE IF NOT EXISTS public.schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())'
    for migration in "$db_dir"/migrations/*.sql; do
      filename="$(basename "$migration")"
      sha256="$(sha256sum "$migration" | cut -d ' ' -f 1)"
      applied="$(psql_admin -Atq -c "SELECT sha256 FROM public.schema_migrations WHERE filename = '$filename'")"
      if [[ -n "$applied" ]]; then
        if [[ "$applied" != "$sha256" ]]; then
          if [[ "$filename" == '0027_delivery_routes_and_tracking.sql' && "$applied" == '515178b1adcb984ef4dc89b78302a7f6cc202cdd02917ed8f1d01b5793cd6472' ]]; then
            echo "Checksum legado reconhecido: $filename (reconciliado por 0028)"
            continue
          fi
          echo "Migração alterada após aplicação: $filename" >&2
          exit 1
        fi
        echo "Já aplicada: $filename"
        continue
      fi
      if [[ "$(head -n 1 "$migration")" != 'BEGIN;' || "$(tail -n 1 "$migration")" != 'COMMIT;' ]]; then
        echo "Migração precisa iniciar com BEGIN e terminar com COMMIT: $filename" >&2
        exit 1
      fi
      {
        printf 'BEGIN;\n'
        sed '1d;$d' "$migration"
        printf "INSERT INTO public.schema_migrations(filename, sha256) VALUES ('%s', '%s');\n" "$filename" "$sha256"
        printf 'COMMIT;\n'
      } | psql_admin -q
      echo "Aplicada: $filename"
    done
    ;;
  test)
    psql_admin -q -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api_test') THEN CREATE ROLE app_api_test LOGIN PASSWORD 'local-test-only' NOSUPERUSER NOBYPASSRLS; END IF; END \$\$; GRANT app_runtime TO app_api_test;"
    psql_admin -q < "$db_dir/tests/002_fixture.sql"
    "$container_cli" exec -i -e PGPASSWORD=local-test-only "$container_name" \
      psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U app_api_test -d "$database_name" \
      < "$db_dir/tests/003_runtime.sql"
    echo 'Testes de isolamento e transação passaram.'
    ;;
  api-roles)
    psql_admin -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='api_auth') THEN
    CREATE ROLE api_auth LOGIN PASSWORD 'local-auth-only' NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='api_tenant') THEN
    CREATE ROLE api_tenant LOGIN PASSWORD 'local-tenant-only' NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='api_platform') THEN
    CREATE ROLE api_platform LOGIN PASSWORD 'local-platform-only' NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='api_worker') THEN
    CREATE ROLE api_worker LOGIN PASSWORD 'local-worker-only' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT app_auth_runtime TO api_auth;
GRANT app_runtime TO api_tenant;
GRANT app_platform_runtime TO api_platform;
GRANT app_worker_runtime TO api_worker;
SQL
    echo 'Papéis locais da API prontos.'
    ;;
  down)
    "$container_cli" stop "$container_name"
    ;;
  *)
    echo "Uso: $0 {up|migrate|api-roles|test|down}" >&2
    exit 2
    ;;
esac
