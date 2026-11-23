#!/usr/bin/env bash
set -euo pipefail
adb_bin="${ADB_BIN:-adb}"
apk="${APK_PATH:-$(cd "$(dirname "$0")/.." && pwd)/releases/entrega-ja-android-v1.0.0-beta.1.1.apk}"
package='com.kynesis.entregaja'
expected_version='1.0.0-beta.1.1'
expected_version_code='24'
if [[ ! -s "$apk" ]]; then echo "APK não encontrado: $apk" >&2; exit 1; fi
if ! command -v "$adb_bin" >/dev/null 2>&1; then echo "ADB não encontrado: $adb_bin" >&2; exit 1; fi
connected="$($adb_bin devices | awk '$2 == "device" { count++ } END { print count+0 }')"
if [[ "$connected" != 1 ]]; then echo "Conecte exatamente um dispositivo Android autorizado no ADB (encontrados: $connected)." >&2; exit 1; fi
badging_bin="${AAPT_BIN:-aapt}"
if command -v "$badging_bin" >/dev/null 2>&1; then
  badging="$($badging_bin dump badging "$apk")"
  grep -Fq "package: name='$package'" <<<"$badging" || { echo "APK usa pacote diferente de $package." >&2; exit 1; }
  grep -Fq "versionCode='$expected_version_code' versionName='$expected_version'" <<<"$badging" || { echo "APK não é a versão $expected_version ($expected_version_code)." >&2; exit 1; }
fi
"$adb_bin" install -r "$apk"
"$adb_bin" logcat -c
"$adb_bin" shell monkey -p "$package" 1
sleep 5
if ! "$adb_bin" shell pidof "$package"; then
  echo 'O aplicativo não permaneceu aberto. Últimos erros:' >&2
  "$adb_bin" logcat -d -t 500 | rg 'FATAL EXCEPTION|ReactNativeJS|AndroidRuntime' >&2 || true
  exit 1
fi
echo 'APK instalado e aplicativo iniciado. Continue o teste de login, offline e foto no aparelho.'
