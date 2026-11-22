#!/usr/bin/env bash
set -euo pipefail

command -v node >/dev/null 2>&1 || { echo 'Node 26 não está disponível no PATH.' >&2; exit 1; }
command -v java >/dev/null 2>&1 || { echo 'JDK 17 não está disponível no PATH.' >&2; exit 1; }
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" == 26 ]] || { echo "Node 26 é obrigatório; encontrado Node $node_major." >&2; exit 1; }

java_version="$(java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)"
[[ "$java_version" == 17 ]] || { echo "JDK 17 é obrigatório; encontrada versão $java_version." >&2; exit 1; }

[[ -n "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]] || { echo 'ANDROID_HOME ou ANDROID_SDK_ROOT é obrigatório.' >&2; exit 1; }
[[ -n "${EXPO_PUBLIC_API_URL:-}" && "$EXPO_PUBLIC_API_URL" == https://* ]] || { echo 'EXPO_PUBLIC_API_URL HTTPS é obrigatório para release.' >&2; exit 1; }
for name in RELEASE_STORE_FILE RELEASE_STORE_PASSWORD RELEASE_KEY_ALIAS RELEASE_KEY_PASSWORD; do
  [[ -n "${!name:-}" ]] || { echo "$name é obrigatório e não deve ser gravado no repositório." >&2; exit 1; }
done
[[ -f "$RELEASE_STORE_FILE" ]] || { echo "Keystore não encontrada: $RELEASE_STORE_FILE" >&2; exit 1; }

echo 'Ambiente Android de release validado.'
