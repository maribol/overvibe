#!/usr/bin/env bash
# Puts the overvibe CLI on PATH: links bin/overvibe into ~/.local/bin (or $1), and `ov` as a short alias
# only when no other `ov` exists (Homebrew has a pager by that name). Run it again any time; it only
# replaces links that already point into this checkout.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
dest=${1:-$HOME/.local/bin}
mkdir -p "$dest"
link() { # name target
  local at="$dest/$1"
  if [ -e "$at" ] || [ -L "$at" ]; then
    case "$(readlink "$at" 2>/dev/null)" in "$repo"/bin/*) ;; *) echo "skipped $1: $at already exists and is not ours"; return ;; esac
  fi
  ln -sfn "$2" "$at" && echo "linked $at -> $2"
}
link overvibe "$repo/bin/overvibe"
other=$(PATH=$(printf %s "$PATH" | tr : '\n' | grep -vxF "$dest" | paste -sd: -) command -v ov || true)
if [ -n "$other" ]; then echo "skipped ov: another ov is on PATH ($other); use overvibe"
else link ov "$repo/bin/overvibe"; fi
case ":$PATH:" in *":$dest:"*) ;; *) echo "note: $dest is not on PATH; add it to your shell profile" ;; esac
