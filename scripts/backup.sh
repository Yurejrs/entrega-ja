#!/usr/bin/env bash
set -euo pipefail
umask 077

command -v pg_dump >/dev/null 2>&1 || {
  echo 'pg_dump é obrigatório no ambiente de backup; instale o cliente PostgreSQL antes de executar.' >&2
  exit 2
}
command -v tar >/dev/null 2>&1 || { echo 'tar é obrigatório no ambiente de backup.' >&2; exit 2; }
command -v sha256sum >/dev/null 2>&1 || { echo 'sha256sum é obrigatório no ambiente de backup.' >&2; exit 2; }
if [[ -z "${BACKUP_DATABASE_URL:-}" ]]; then
  echo 'BACKUP_DATABASE_URL é obrigatório e deve usar uma credencial de backup privilegiada.' >&2
  exit 2
fi
if [[ -z "${FILE_STORAGE_DIR:-}" || ! -d "$FILE_STORAGE_DIR" ]]; then
  echo 'FILE_STORAGE_DIR deve apontar para o armazenamento privado existente.' >&2
  exit 2
fi

backup_root="${BACKUP_DIR:-./backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_root"
target="$(mktemp -d "$backup_root/entregaja-$timestamp-XXXXXX.partial")"
trap 'echo "Backup incompleto em $target" >&2' ERR

pg_dump --format=custom --no-owner --file="$target/database.dump" "$BACKUP_DATABASE_URL"
tar --create --file="$target/private-files.tar" --sort=name --directory="$FILE_STORAGE_DIR" .
(cd "$target" && sha256sum database.dump private-files.tar > SHA256SUMS)
mv "$target" "${target%.partial}"
target="${target%.partial}"
chmod 600 "$target/database.dump" "$target/private-files.tar" "$target/SHA256SUMS"
printf 'Backup criado em %s\n' "$target"
