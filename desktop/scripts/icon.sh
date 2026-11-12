#!/usr/bin/env bash
# Makes build/icon.icns. The Overvibe icon (build/icon.png, 1024 px) is committed; this rebuilds the .icns
# from it if it is missing. Needs sips and iconutil.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
tmp=$(mktemp -d)
[ -f build/icon.png ] || { echo "build/icon.png is missing (the 1024 px Overvibe icon)" >&2; exit 1; }
set=$tmp/icon.iconset
mkdir -p "$set"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "$set/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/icon.png --out "$set/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$set" -o build/icon.icns
rm -rf "$tmp"
echo "build/icon.icns"
