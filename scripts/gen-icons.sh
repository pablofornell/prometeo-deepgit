#!/usr/bin/env bash
# Rebuilds every app icon from the spec in docs/design/ITERATION-3.md (section 13).
#
#   1. scripts/gen-logo.mjs writes the SVGs and src/features/welcome/logoData.ts.
#   2. npx tauri icon renders the large variant, and the 1024 px PNG.
#   3. npx tauri icon renders the small variant, for the sizes under 64 px.
#   4. The large-variant rasters are copied into src-tauri/icons/.
#   5. The small-variant rasters are copied into src-tauri/icons/.
#   6. scripts/pack-ico.py packs icon.ico (16-48 px small, 64 and 256 px large).
#   7. Every raster is checked against the size in its file name.
#
# Needs: node and npx (run `npm install` first), and Python 3 with Pillow (pip install pillow).
# Run from anywhere: bash scripts/gen-icons.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICONS="$ROOT/src-tauri/icons"
TOTAL=7
WORK="$(mktemp -d)"
trap 'rm -rf -- "${WORK:?}"' EXIT

# Runs `npx tauri icon` and keeps its output in a log, shown only on failure.
run_tauri() {
  local input="$1"
  shift
  if ! npx tauri icon "$input" "$@" >"$WORK/tauri.log" 2>&1; then
    cat "$WORK/tauri.log" >&2
    echo "tauri icon failed for $input" >&2
    exit 1
  fi
}

echo "[1/$TOTAL] Check the tools"
for tool in node npx python3; do
  command -v "$tool" >/dev/null || { echo "$tool not found" >&2; exit 1; }
done
python3 -c "import PIL" 2>/dev/null || { echo "Pillow not found: pip install pillow" >&2; exit 1; }
[ -d "$ROOT/node_modules" ] || { echo "node_modules not found: run npm install" >&2; exit 1; }

echo "[2/$TOTAL] Write the SVGs and the Welcome logo data (gen-logo.mjs)"
node "$ROOT/scripts/gen-logo.mjs"

echo "[3/$TOTAL] Render the large variant with tauri icon (all sizes, and 1024 px)"
mkdir -p "$WORK/large" "$WORK/large-1024"
run_tauri "$ICONS/logo.svg" -o "$WORK/large"
run_tauri "$ICONS/logo.svg" -p 1024 -o "$WORK/large-1024"

echo "[4/$TOTAL] Render the small variant with tauri icon (for the sizes under 64 px)"
mkdir -p "$WORK/small"
run_tauri "$ICONS/logo-small.svg" -o "$WORK/small"

echo "[5/$TOTAL] Copy the large-variant rasters into src-tauri/icons"
for f in icon.png 64x64.png 128x128.png 128x128@2x.png icon.icns \
  Square89x89Logo.png Square107x107Logo.png Square142x142Logo.png Square150x150Logo.png \
  Square284x284Logo.png Square310x310Logo.png StoreLogo.png; do
  cp "$WORK/large/$f" "$ICONS/$f"
done
cp "$WORK/large-1024/1024x1024.png" "$ICONS/logo-1024.png"

echo "[6/$TOTAL] Copy the small-variant rasters into src-tauri/icons, and pack icon.ico"
for f in 32x32.png Square30x30Logo.png Square44x44Logo.png Square71x71Logo.png; do
  cp "$WORK/small/$f" "$ICONS/$f"
done
python3 "$ROOT/scripts/pack-ico.py" "$WORK/small/icon.ico" "$WORK/large/icon.ico" "$ICONS/icon.ico"

echo "[7/$TOTAL] Check the size of every raster against its file name"
python3 - "$ICONS" <<'EOF'
import sys
from pathlib import Path
from PIL import Image

icons = Path(sys.argv[1])
expected = {
    "32x32.png": 32, "64x64.png": 64, "128x128.png": 128, "128x128@2x.png": 256,
    "icon.png": 512, "logo-1024.png": 1024, "StoreLogo.png": 50,
    "Square30x30Logo.png": 30, "Square44x44Logo.png": 44, "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89, "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150, "Square284x284Logo.png": 284, "Square310x310Logo.png": 310,
}
bad = [f"{name}: {Image.open(icons / name).size}, expected {n}x{n}"
       for name, n in expected.items() if Image.open(icons / name).size != (n, n)]
if bad:
    sys.exit("size check failed:\n" + "\n".join(bad))
print(f"{len(expected)} rasters checked")
EOF

echo "Done. Review the result with: git status -- src-tauri/icons src/features/welcome public/favicon.svg"
