#!/usr/bin/env bash
# Packages "Overvibe.app" (unsigned, for this Mac) into ~/Applications.
set -euo pipefail
cd "$(dirname "$0")/.."
# the packaged app has no checkout around it: record where the server runs from
# (in the config folder main.cjs reads: ~/.config/agent-deck on an install from before the rename, else ~/.config/overvibe)
if [ -d "$HOME/.config/agent-deck" ] && [ ! -L "$HOME/.config/agent-deck" ] && { [ -f "$HOME/.config/agent-deck/token" ] || [ ! -d "$HOME/.config/overvibe" ] || [ -L "$HOME/.config/overvibe" ]; }; then data="$HOME/.config/agent-deck"; else data="$HOME/.config/overvibe"; fi
mkdir -p "$data" && (cd .. && pwd) > "$data/repo"
[ -f build/icon.icns ] || bash scripts/icon.sh
out=$(mktemp -d)
bunx electron-packager . "Overvibe" \
  --platform=darwin --arch="$(uname -m | sed 's/x86_64/x64/')" \
  --icon=build/icon.icns --app-bundle-id=local.agent-deck.desktop \
  --app-category-type=public.app-category.developer-tools \
  --ignore='^/build' --ignore='^/scripts' --ignore='^/README' --ignore='^/node_modules' \
  --asar --overwrite --out="$out" >/dev/null
mkdir -p "$HOME/Applications"
app="$HOME/Applications/Overvibe.app"
rm -rf "$app"
mv "$out"/Overvibe-darwin-*/"Overvibe.app" "$app"
rm -rf "$out"
echo "$app"
