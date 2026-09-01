#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PLUGIN_NAME="decky-hardware-monitor"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found, enabling via corepack..."
  corepack enable
fi

echo "Installing dependencies..."
pnpm i

echo "Building frontend..."
rm -rf dist
pnpm run build

echo "Staging plugin files..."
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

PLUGIN_DIR="$STAGE/$PLUGIN_NAME"
mkdir -p "$PLUGIN_DIR/dist"
cp plugin.json package.json main.py README.md "$PLUGIN_DIR/"
cp dist/index.js dist/index.js.map "$PLUGIN_DIR/dist/"

echo "Creating zip..."
OUT_ZIP="$(pwd)/$PLUGIN_NAME.zip"
rm -f "$OUT_ZIP"
python3 - "$STAGE" "$PLUGIN_NAME" "$OUT_ZIP" <<'PYEOF'
import os
import sys
import zipfile

stage, plugin_name, out_zip = sys.argv[1:4]
root = os.path.join(stage, plugin_name)

with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
    for dirpath, _, filenames in os.walk(root):
        for fname in filenames:
            full = os.path.join(dirpath, fname)
            arcname = os.path.relpath(full, stage)
            zf.write(full, arcname)
PYEOF

echo "Built $OUT_ZIP"
