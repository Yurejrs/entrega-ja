#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
tool_root="${ENTREGAJA_TOOLS_ROOT:-/home/yure/.cache/entregaja-tools}"
export PATH="${tool_root}/node-v26.13.1/bin:${tool_root}/jdk17/bin:${tool_root}/android-sdk/platform-tools:${tool_root}/android-sdk/build-tools/36.0.0:${root_dir}/scripts:${PATH}"
export JAVA_HOME="${JAVA_HOME:-${tool_root}/jdk17}"
export ANDROID_HOME="${ANDROID_HOME:-${tool_root}/android-sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export NODE26_BIN="${NODE26_BIN:-${tool_root}/node-v26.13.1/bin/node}"
export PNPM_MJS="${PNPM_MJS:-/home/yure/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.mjs}"

: "${EXPO_PUBLIC_API_URL:?Defina EXPO_PUBLIC_API_URL com HTTPS de produção}"
: "${RELEASE_STORE_FILE:?Defina RELEASE_STORE_FILE com a keystore de produção}"
: "${RELEASE_STORE_PASSWORD:?Defina RELEASE_STORE_PASSWORD fora do repositório}"
: "${RELEASE_KEY_ALIAS:?Defina RELEASE_KEY_ALIAS fora do repositório}"
: "${RELEASE_KEY_PASSWORD:?Defina RELEASE_KEY_PASSWORD fora do repositório}"
: "${RELEASE_PRODUCTION_APPROVED:?Defina RELEASE_PRODUCTION_APPROVED=true somente após conferir a keystore de produção}"

[[ "$EXPO_PUBLIC_API_URL" == https://* ]] || { echo 'EXPO_PUBLIC_API_URL precisa usar HTTPS.' >&2; exit 2; }
[[ "$RELEASE_PRODUCTION_APPROVED" == true ]] || { echo 'Defina RELEASE_PRODUCTION_APPROVED=true somente após conferir a keystore de produção.' >&2; exit 2; }
[[ "$RELEASE_STORE_FILE" != *test-release.jks ]] || { echo 'A keystore temporária não pode publicar a release.' >&2; exit 2; }

"$root_dir/scripts/check-android-release-env.sh"
cd "$root_dir"
pnpm --filter @entregas/mobile build:android:release

apk="$root_dir/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
destination="$root_dir/releases/entrega-ja-android-v1.0.0.apk"
mkdir -p "$root_dir/releases"
aapt dump badging "$apk" | grep -Fq "package: name='com.kynesis.entregaja' versionCode='25' versionName='1.0.0'" \
  || { echo 'APK não corresponde ao pacote/versão esperados.' >&2; exit 1; }
apksigner verify --verbose "$apk" | grep -Fq 'Verified using v2 scheme (APK Signature Scheme v2): true' \
  || { echo 'APK não passou na assinatura v2.' >&2; exit 1; }
manifest="$(aapt dump xmltree "$apk" AndroidManifest.xml)"
grep -Fq 'usesCleartextTraffic(0x010104ec)=(type 0x12)0x0' <<<"$manifest" \
  || { echo 'O manifesto do APK precisa desativar tráfego HTTP sem TLS.' >&2; exit 1; }
app_config="$(unzip -p "$apk" assets/app.config)"
EXPO_APP_CONFIG="$app_config" EXPO_EXPECTED_API_URL="$EXPO_PUBLIC_API_URL" node -e '
  const config = JSON.parse(process.env.EXPO_APP_CONFIG);
  const expected = process.env.EXPO_EXPECTED_API_URL;
  if (config.extra?.apiUrl !== expected || !expected.startsWith("https://")) {
    console.error("A URL HTTPS configurada não foi incorporada ao APK.");
    process.exit(1);
  }
'
cp "$apk" "$destination"
sha256sum "$destination" > "$root_dir/releases/SHA256SUMS"
chmod 0644 "$destination" "$root_dir/releases/SHA256SUMS"
echo "Artefato publicado localmente: $destination"
cat "$root_dir/releases/SHA256SUMS"
