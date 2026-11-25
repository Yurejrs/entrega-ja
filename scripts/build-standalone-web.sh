#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cd "$root_dir/apps/web"
node_modules/.bin/vite build --outDir "$tmp_dir" --emptyOutDir

python3 - "$tmp_dir" "$root_dir/gestao-web.html" <<'PY'
import re
import sys
from pathlib import Path

build_dir = Path(sys.argv[1])
output = Path(sys.argv[2])
html = (build_dir / 'index.html').read_text(encoding='utf-8')


def asset_url(url: str) -> Path | None:
    if url.startswith(('http://', 'https://', '//', 'data:')):
        return None
    return build_dir / url.lstrip('/')


def inline_script(match: re.Match[str]) -> str:
    path = asset_url(match.group(1))
    if path is None:
        return match.group(0)
    source = path.read_text(encoding='utf-8').replace('</script>', '<\\/script>')
    return f'<script type="module">{source}</script>'


def inline_style(match: re.Match[str]) -> str:
    path = asset_url(match.group(1))
    if path is None:
        return match.group(0)
    source = path.read_text(encoding='utf-8').replace('</style>', '<\\/style>')
    return f'<style>{source}</style>'


html = re.sub(r'<script\b[^>]*\bsrc="([^"]+)"[^>]*></script>', inline_script, html)
html = re.sub(r'<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>', inline_style, html)
if '/assets/' in html:
    raise SystemExit('Ainda existem referências a assets externos no HTML standalone.')
output.write_text(html, encoding='utf-8')
print(f'HTML standalone gerado: {output}')
PY
