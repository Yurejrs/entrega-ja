#!/usr/bin/env bash
set -euo pipefail
adb_bin="${ADB_BIN:-adb}"
apk="${APK_PATH:-$(cd "$(dirname "$0")/.." && pwd)/releases/entrega-ja-android-v0.1.20-teste.apk}"
package='br.com.entregaja.entregador'
if [[ ! -s "$apk" ]]; then echo "APK não encontrado: $apk" >&2; exit 1; fi
connected="$($adb_bin devices | awk '$2 == "device" { count++ } END { print count+0 }')"
if [[ "$connected" != 1 ]]; then echo "Conecte exatamente um dispositivo Android autorizado no ADB (encontrados: $connected)." >&2; exit 1; fi
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
