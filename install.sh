#!/bin/sh
# Overvibe installer and service control (macOS and Linux; Windows through WSL2).
#
#   curl -fsSL https://overvibe.dev/install.sh | sh          install or update, start at login, open the page
#
# To read it before it runs (it is one file, no downloads besides the app itself and, if you say yes, Bun
# and tmux):
#   curl -fsSLo install.sh https://overvibe.dev/install.sh; less install.sh; sh install.sh
#
#   sh install.sh [install] [--ref TAG|BRANCH] [--dir DIR] [--port N] [--yes] [--no-service] [--no-open]
#   sh install.sh uninstall                                  remove the login service and the CLI links only
#   sh install.sh update                                     what `overvibe update` runs: the newest release into
#                                                            ~/.overvibe/app (or --dir), build, restart; no browser
#   sh install.sh up | down | open | doctor                  what `overvibe up/down/open/doctor` run
#
# Install: checks the OS, finds or installs Bun and tmux (asks first, never sudo: on a Mac with Homebrew, on
# Linux Bun's own installer and the distro's package command for tmux, which it prints when it needs root),
# clones or updates the app into ~/.overvibe/app (or --dir; run from a clone it uses that clone as it is)
# at the newest release tag (v1.2.3), or main when there is none, or --ref; runs `bun install
# --frozen-lockfile` and the UI build, links `overvibe` and `ov` (ov only if free) into ~/.local/bin,
# installs a per-user login service that runs the server on 127.0.0.1 at login (macOS: a launchd agent,
# ~/Library/LaunchAgents/dev.overvibe.server.plist; Linux: a systemd --user unit,
# ~/.config/systemd/user/overvibe.service, or a plain background start where systemd user sessions are not
# there, as on WSL without systemd), waits until GET /api/health says it is Overvibe, and opens the login
# link in the browser. The token is never printed. Any failed step (fetch, update, install, build) stops it.
# A port held by something that is not Overvibe stops it too. Run it again any time: it updates and
# restarts. Uninstall never touches sessions, transcripts or ~/.config/overvibe.
#
# Environment (each flag has one): OVERVIBE_DIR, OVERVIBE_REPO (git URL), OVERVIBE_REF, OVERVIBE_PORT,
# OVERVIBE_BIN_DIR, OVERVIBE_YES=1, OVERVIBE_NO_SERVICE=1 (or the old OVERVIBE_NO_LAUNCHD=1: no login
# service, start the server directly, and remove one an earlier install left), OVERVIBE_NO_OPEN=1,
# OVERVIBE_LAUNCHCTL and OVERVIBE_SYSTEMCTL (the launchctl / systemctl to call; tests point them at a stub), plus the server's own OVERVIBE_DATA_DIR, OVERVIBE_TMUX_SOCKET,
# OVERVIBE_ACCOUNTS_DIR, OVERVIBE_CODEX_ACCOUNTS_DIR and DECK_WORK_ROOT, which are passed on to the server.
set -eu
# the whole script sits in one { } group, so under curl | sh it is read to the end before anything runs
{
LABEL=dev.overvibe.server
REPO_URL=${OVERVIBE_REPO:-https://github.com/maribol/overvibe.git}
REF=${OVERVIBE_REF:-}
BIN_DIR=${OVERVIBE_BIN_DIR:-$HOME/.local/bin}
# the config folder, as src/env.ts dataDirFor picks it: ~/.config/overvibe, or ~/.config/agent-deck on an
# install from before the rename (kept where it is; the server links the new name to it) [T1110-80]
real_dir() { [ -d "$1" ] && [ ! -L "$1" ]; }
if [ -n "${OVERVIBE_DATA_DIR:-}" ]; then DATA_DIR=$OVERVIBE_DATA_DIR
elif real_dir "$HOME/.config/agent-deck" && { [ -f "$HOME/.config/agent-deck/token" ] || ! real_dir "$HOME/.config/overvibe"; }; then DATA_DIR=$HOME/.config/agent-deck
else DATA_DIR=$HOME/.config/overvibe; fi
case $DATA_DIR in "~"*) DATA_DIR=$HOME${DATA_DIR#\~} ;; esac
# the OS: macOS (launchd) or Linux (systemd --user); WSL2 is Linux whose kernel release says "microsoft" [T1111-8]
OS_=$(uname -s)
IS_WSL=0
[ "$OS_" = Linux ] && grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null && IS_WSL=1
UNIT=overvibe.service
if [ "$OS_" = Darwin ]; then
  AGENT_PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
  LOG_DIR=$HOME/Library/Logs/Overvibe
else
  AGENT_PLIST=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT
  LOG_DIR=${XDG_STATE_HOME:-$HOME/.local/state}/overvibe
fi
# PLIST: the service file (a launchd plist on a Mac, a systemd unit on Linux); it also records the app folder and port
PLIST=$AGENT_PLIST
LOG=$LOG_DIR/server.log
PIDFILE=$DATA_DIR/server.pid
NO_LAUNCHD=${OVERVIBE_NO_SERVICE:-${OVERVIBE_NO_LAUNCHD:-0}}
# 1 when Linux has no systemd user session, so the server starts directly (set below; not the --no-service choice)
NO_SYSTEMD=0
NO_OPEN=${OVERVIBE_NO_OPEN:-0}
YES=${OVERVIBE_YES:-0}
PORT=${OVERVIBE_PORT:-}
APP_DIR=${OVERVIBE_DIR:-}
LAUNCHCTL=${OVERVIBE_LAUNCHCTL:-launchctl}
SYSTEMCTL=${OVERVIBE_SYSTEMCTL:-systemctl}
UID_=$(id -u)

say() { printf '%s\n' "$*"; }
warn() { printf 'overvibe: %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }
# a yes/no question on the terminal (stdin is the script itself under curl | sh); no terminal means no
ask() {
  [ "$YES" = 1 ] && return 0
  ( : </dev/tty ) 2>/dev/null || return 1
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r a </dev/tty || return 1
  case $a in y | Y | yes | Yes) return 0 ;; esac
  return 1
}

usage() {
  cat <<'EOF'
Overvibe installer (macOS and Linux; on Windows, run it inside WSL2)

  curl -fsSL https://overvibe.dev/install.sh | sh
  curl -fsSLo install.sh https://overvibe.dev/install.sh; less install.sh; sh install.sh   (read it first)

  sh install.sh [install] [options]   install or update, start the server at login, open the page
  sh install.sh uninstall             remove the login service and the CLI links (sessions, transcripts and
                                      ~/.config/overvibe stay)
  sh install.sh update                update an installed Overvibe (~/.overvibe/app, or --dir) to the newest
                                      release, build it and restart the server; a clone you run yourself
                                      is left alone (git pull it)
  sh install.sh up | down             start or stop the server
  sh install.sh open                  open the page in the browser, logged in
  sh install.sh doctor                check the setup

Options:
  --ref TAG|BRANCH   install that version (default: the newest v* release tag, else main)
  --dir DIR          app folder (default ~/.overvibe/app; from a clone, the clone itself)
  --port N           port on 127.0.0.1 (default 7777)
  --yes              install missing tools and add ~/.local/bin to PATH without asking
  --no-service       no login service (launchd agent or systemd unit): start the server directly
                     (removes one an earlier install left); --no-launchd is the old name
  --no-open          do not open the browser
  --repo URL         git URL to install from
EOF
}

# ---------- arguments ----------
CMD=install
while [ $# -gt 0 ]; do
  case $1 in
    install | uninstall | update | up | down | open | doctor) CMD=$1 ;;
    --uninstall) CMD=uninstall ;;
    --dir) APP_DIR=${2:?--dir needs a folder}; DIR_GIVEN=1; shift ;;
    --dir=*) APP_DIR=${1#--dir=}; DIR_GIVEN=1 ;;
    --port) PORT=${2:?--port needs a number}; shift ;;
    --port=*) PORT=${1#--port=} ;;
    --ref) REF=${2:?--ref needs a tag or branch}; shift ;;
    --ref=*) REF=${1#--ref=} ;;
    --repo) REPO_URL=${2:?--repo needs a git URL}; shift ;;
    -y | --yes) YES=1 ;;
    --no-launchd | --no-service) NO_LAUNCHD=1 ;;
    --no-open) NO_OPEN=1 ;;
    -h | --help | help) usage; exit 0 ;;
    *) die "unknown option $1 (try --help)" ;;
  esac
  shift
done

# Linux without a systemd user session (WSL without systemd, a container): start directly, nothing at login
if [ "$OS_" = Linux ] && [ "$NO_LAUNCHD" != 1 ] && ! "$SYSTEMCTL" --user show-environment >/dev/null 2>&1; then
  NO_LAUNCHD=1; NO_SYSTEMD=1
fi
# --no-service: the settings file is written where launchd or systemd never looks (so it is not loaded at next login either)
if [ "$NO_LAUNCHD" = 1 ]; then
  if [ "$OS_" = Darwin ]; then PLIST=$HOME/.overvibe/$LABEL.plist; else PLIST=$HOME/.overvibe/$UNIT; fi
fi
# a value saved in the service file: WorkingDirectory, or DECK_PORT from its environment
svc_value() {
  [ -f "$PLIST" ] || return 1
  if [ "$OS_" = Darwin ]; then
    case $1 in dir) plutil -extract WorkingDirectory raw -o - "$PLIST" 2>/dev/null ;; port) plutil -extract EnvironmentVariables.DECK_PORT raw -o - "$PLIST" 2>/dev/null ;; esac
  else
    case $1 in
      dir) sed -n 's/^WorkingDirectory=//p' "$PLIST" | head -n 1 | sed 's/%%/%/g' ;;
      port) sed -n 's/^Environment="DECK_PORT=\([0-9]*\)"$/\1/p' "$PLIST" | head -n 1 ;;
    esac
  fi
}

# where this script lives: a git clone (use it in place), the npm package (bunx overvibe), or nowhere (curl | sh)
HERE=
case $0 in */install.sh | install.sh) HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || HERE= ;; esac
if [ -z "$APP_DIR" ]; then
  if [ -n "$HERE" ] && [ -d "$HERE/.git" ] && [ -f "$HERE/server.ts" ]; then APP_DIR=$HERE
  elif wd=$(svc_value dir) && [ -n "$wd" ] && [ -f "$wd/server.ts" ]; then APP_DIR=$wd
  elif [ -n "$HERE" ] && [ "$CMD" != install ] && [ -f "$HERE/server.ts" ]; then APP_DIR=$HERE
  else APP_DIR=$HOME/.overvibe/app; fi
fi
case $APP_DIR in "~"*) APP_DIR=$HOME${APP_DIR#\~} ;; esac
# the port: the flag or env, else the one the login agent was installed with, else 7777
if [ -z "$PORT" ] && [ -f "$PLIST" ]; then PORT=$(svc_value port || true); fi
PORT=${PORT:-7777}
case $PORT in *[!0-9]* | '') die "--port must be a number (got $PORT)" ;; esac
URL=http://127.0.0.1:$PORT

# ---------- lookups ----------
brew_bin() { command -v brew 2>/dev/null || { [ -x /opt/homebrew/bin/brew ] && echo /opt/homebrew/bin/brew; } || { [ -x /usr/local/bin/brew ] && echo /usr/local/bin/brew; } || true; }
# Bun's installer puts it in $BUN_INSTALL when that is set, else ~/.bun
bun_bin() { command -v bun 2>/dev/null || { [ -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ] && echo "${BUN_INSTALL:-$HOME/.bun}/bin/bun"; } || { [ -x "$HOME/.bun/bin/bun" ] && echo "$HOME/.bun/bin/bun"; } || true; }
# the real tmux: OVERVIBE_TMUX_BIN inside an Overvibe session, where `tmux` on PATH is the guard shim [T1111-18]
tmux_bin() { { [ -n "${OVERVIBE_TMUX_BIN:-}" ] && [ -x "$OVERVIBE_TMUX_BIN" ] && echo "$OVERVIBE_TMUX_BIN"; } || { t=$(command -v tmux 2>/dev/null) && ! grep -q 'overvibe-tmux-shim' "$t" 2>/dev/null && echo "$t"; } || { [ -x /opt/homebrew/bin/tmux ] && echo /opt/homebrew/bin/tmux; } || { [ -x /usr/local/bin/tmux ] && echo /usr/local/bin/tmux; } || { [ -x /usr/bin/tmux ] && echo /usr/bin/tmux; } || true; }
cli_bin() { command -v "$1" 2>/dev/null || { [ -x "$HOME/.local/bin/$1" ] && echo "$HOME/.local/bin/$1"; } || true; }
# what GET /api/health says (empty when nothing answers or it is not JSON from Overvibe)
health() { curl -s --max-time 2 "$URL/api/health" 2>/dev/null || true; }
# an Overvibe server answers on the port: /api/health names this exact app
answering() { health | grep -q '"app":"overvibe"'; }
# anything at all holds the port (a listener, or any HTTP answer)
port_taken() { [ -n "$(listener_pid)" ] || curl -s -o /dev/null --max-time 2 "$URL/" 2>/dev/null; }
# the pid listening on the port: lsof (macOS, most Linux), else ss (iproute2), else fuser (psmisc)
listener_pid() {
  if command -v lsof >/dev/null 2>&1; then lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1
  elif command -v ss >/dev/null 2>&1; then ss -ltnp 2>/dev/null | awk -v p=":$PORT" '$1 == "LISTEN" && substr($4, length($4) - length(p) + 1) == p' | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -n 1
  elif command -v fuser >/dev/null 2>&1; then fuser -n tcp "$PORT" 2>/dev/null | awk '{ print $1; exit }'
  fi
}
# a process's command line: ps where it exists, else /proc (slim Linux images have no ps)
cmd_of() { ps -p "$1" -o command= 2>/dev/null || { [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' <"/proc/$1/cmdline"; } || true; }
agent_loaded() {
  [ "$NO_LAUNCHD" != 1 ] || return 1
  if [ "$OS_" = Darwin ]; then "$LAUNCHCTL" print "gui/$UID_/$LABEL" >/dev/null 2>&1
  else case $("$SYSTEMCTL" --user show -p ActiveState --value "$UNIT" 2>/dev/null) in active | activating | reloading) return 0 ;; *) return 1 ;; esac; fi
}
agent_pid() {
  agent_loaded || return 1
  if [ "$OS_" = Darwin ]; then "$LAUNCHCTL" print "gui/$UID_/$LABEL" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }'
  else p=$("$SYSTEMCTL" --user show -p MainPID --value "$UNIT" 2>/dev/null); [ -n "$p" ] && [ "$p" != 0 ] && echo "$p"; fi
}
# the server this script started directly (--no-launchd), only if that pid is still a bun server.ts
direct_pid() {
  [ -f "$PIDFILE" ] || return 0
  p=$(cat "$PIDFILE" 2>/dev/null || true)
  case $p in '' | *[!0-9]*) return 0 ;; esac
  cmd_of "$p" | grep -q 'server\.ts' && echo "$p"
  return 0
}
# the listener on the port is ours (the login agent's or the direct one), or nothing listens
ours_or_free() {
  l=$(listener_pid)
  [ -z "$l" ] && return 0
  [ "$l" = "$(agent_pid || true)" ] && return 0
  [ "$l" = "$(direct_pid)" ] && return 0
  return 1
}
# something that is not Overvibe holds the port: stop, and never open a browser at it
refuse_foreign() {
  if port_taken && ! answering; then
    die "port $PORT is taken by something that is not Overvibe (pid $(listener_pid || true)); stop it or use --port"
  fi
}
version_of() { # app dir -> "v1.2.0 (abc1234)" or "1.0.0 (abc1234)"
  d=$1
  tag=$(git -C "$d" describe --tags --exact-match 2>/dev/null || true)
  sha=$(git -C "$d" rev-parse --short HEAD 2>/dev/null || true)
  pkg=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$d/package.json" 2>/dev/null | head -n 1)
  printf '%s%s' "${tag:-${pkg:-unknown}}" "${sha:+ ($sha)}"
}

# ---------- install steps ----------
# macOS, or Linux (WSL2 included); native Windows has no tmux, so it is not supported there
check_os() {
  case $OS_ in
    Darwin | Linux) ;;
    MINGW* | MSYS* | CYGWIN*) die "Overvibe needs tmux, which native Windows lacks. Use WSL2: in PowerShell run wsl --install, open Ubuntu, and run this installer there." ;;
    *) die "Overvibe runs on macOS and Linux (this is $OS_)." ;;
  esac
}

# the Linux package command for some packages, as the user would type it (sudo unless already root)
pkg_cmd() {
  s=sudo; [ "$UID_" = 0 ] && s=
  if command -v apt-get >/dev/null 2>&1; then echo "${s:+$s }apt-get install -y $*"
  elif command -v dnf >/dev/null 2>&1; then echo "${s:+$s }dnf install -y $*"
  elif command -v pacman >/dev/null 2>&1; then echo "${s:+$s }pacman -S --needed --noconfirm $*"
  elif command -v zypper >/dev/null 2>&1; then echo "${s:+$s }zypper install -y $*"
  elif command -v apk >/dev/null 2>&1; then echo "${s:+$s }apk add $*"
  else echo "your package manager's install command for: $*"; fi
}
# Linux: a missing package. As root it offers to run the install (after asking); otherwise it prints the
# command and stops, since it never runs sudo itself
need_pkg() { # what, packages...
  what=$1; shift
  c=$(pkg_cmd "$@")
  are=is; [ "$#" -gt 1 ] && are=are
  if [ "$UID_" = 0 ] && [ "${c#your }" = "$c" ] && ask "$what $are missing. Install now ($c)?"; then
    # apt needs a fresh package list on a new system
    case $c in apt-get*) apt-get update -qq </dev/null >/dev/null 2>&1 || true ;; esac
    sh -c "$c" </dev/null || die "$c failed"
  else
    die "$what $are needed. Install with: $c, then run this again."
  fi
}

# Linux: every missing package in one go (git, curl, tmux, and unzip when Bun still has to be installed), so a
# new machine needs one install command, not one run per package
linux_packages() {
  [ "$OS_" = Linux ] || return 0
  miss=
  { command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; } || miss="$miss git"
  command -v curl >/dev/null 2>&1 || miss="$miss curl"
  [ -n "$(tmux_bin)" ] || miss="$miss tmux"
  [ -z "$(bun_bin)" ] && ! command -v unzip >/dev/null 2>&1 && miss="$miss unzip"
  [ -n "$miss" ] || return 0
  # shellcheck disable=SC2086
  need_pkg "$(echo $miss | sed 's/ /, /g')" $miss
}

ensure_git() {
  if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
    [ "$OS_" = Darwin ] && die "git is missing. Install the Command Line Tools with: xcode-select --install, then run this again."
    need_pkg git git
  fi
  command -v curl >/dev/null 2>&1 || { [ "$OS_" = Darwin ] && die "curl is missing; it ships with macOS, so check your PATH."; need_pkg curl curl; }
}

# Bun's own installer, into ~/.bun; it ends by asking you to edit your shell profile, which Overvibe does not need
bun_official() {
  curl -fsSL https://bun.sh/install </dev/null | bash || die "the Bun installer failed"
  say "Overvibe runs Bun from ${BUN_INSTALL:-~/.bun}/bin, so the PATH lines Bun printed are optional."
}

ensure_bun() {
  BUN=$(bun_bin)
  [ -n "$BUN" ] && return 0
  brew=; [ "$OS_" = Darwin ] && brew=$(brew_bin)
  if [ -n "$brew" ] && ask "Bun is missing. Install it with Homebrew (brew install oven-sh/bun/bun)?"; then
    # Homebrew refuses to build on a Mac whose Command Line Tools are older than macOS; Bun's own installer needs none
    if ! "$brew" install oven-sh/bun/bun </dev/null; then
      warn "brew install oven-sh/bun/bun failed"
      ask "Install Bun with its official installer instead (curl -fsSL https://bun.sh/install | bash, into ~/.bun, no sudo)?" || die "Bun is needed. Install it (https://bun.sh) and run this again."
      bun_official
    fi
  elif [ -z "$brew" ] && ask "Bun is missing. Install it with its official installer (curl -fsSL https://bun.sh/install | bash, into ~/.bun, no sudo)?"; then
    # Bun's installer unpacks a zip
    [ "$OS_" = Linux ] && ! command -v unzip >/dev/null 2>&1 && need_pkg "unzip (Bun's installer needs it)" unzip
    bun_official
  elif [ "$OS_" = Darwin ]; then
    die "Bun is needed. Install it (https://bun.sh, or brew install oven-sh/bun/bun) and run this again."
  else
    die "Bun is needed. Install it with: curl -fsSL https://bun.sh/install | bash (https://bun.sh), and run this again."
  fi
  BUN=$(bun_bin)
  [ -n "$BUN" ] || die "Bun was installed but is not on PATH; open a new terminal and run this again."
}

ensure_tmux() {
  TMUX_=$(tmux_bin)
  [ -n "$TMUX_" ] && return 0
  if [ "$OS_" = Linux ]; then
    need_pkg tmux tmux
  else
    brew=$(brew_bin)
    if [ -n "$brew" ] && ask "tmux is missing. Install it with Homebrew (brew install tmux)?"; then
      "$brew" install tmux </dev/null || die "brew install tmux failed"
    elif [ -z "$brew" ]; then
      die "tmux is needed. Install Homebrew (https://brew.sh), then: brew install tmux, and run this again."
    else
      die "tmux is needed: brew install tmux, then run this again."
    fi
  fi
  TMUX_=$(tmux_bin)
  [ -n "$TMUX_" ] || die "tmux was installed but is not on PATH; open a new terminal and run this again."
}

# which version to install: --ref, else the highest vX.Y.Z tag on the remote, else main
pick_ref() {
  [ -n "$REF" ] && { REF_KIND=given; return 0; }
  tags=$(git ls-remote --tags --refs "$REPO_URL" 'v*' </dev/null) || die "could not reach $REPO_URL (git ls-remote failed)"
  REF=$(printf '%s\n' "$tags" | sed -n 's#.*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$#\1#p' |
    sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1)
  if [ -n "$REF" ]; then REF_KIND=release; else REF=main; REF_KIND=branch; fi
}

# put $APP_DIR on $REF: a tag is checked out detached, a branch fast-forwarded; any failure stops the install
checkout_ref() {
  d=$1
  if git -C "$d" rev-parse -q --verify "refs/tags/$REF" >/dev/null; then
    git -C "$d" -c advice.detachedHead=false checkout --quiet "refs/tags/$REF" </dev/null || die "could not check out $REF in $d"
  elif git -C "$d" rev-parse -q --verify "refs/remotes/origin/$REF" >/dev/null; then
    if git -C "$d" rev-parse -q --verify "refs/heads/$REF" >/dev/null; then
      git -C "$d" checkout --quiet "$REF" </dev/null || die "could not check out $REF in $d"
      git -C "$d" merge --ff-only --quiet "origin/$REF" </dev/null || die "could not fast-forward $REF in $d (git pull --ff-only would fail); not installing an old checkout"
    else
      git -C "$d" checkout --quiet -b "$REF" --track "origin/$REF" </dev/null || die "could not check out $REF in $d"
    fi
  else
    die "no tag or branch \"$REF\" in $REPO_URL"
  fi
}

fetch_app() {
  if [ -d "$APP_DIR/.git" ] && [ "$APP_DIR" = "$HERE" ] && [ "$CMD" != update ]; then
    say "Using this checkout as it is: $APP_DIR"
    return 0
  fi
  if [ -d "$APP_DIR/.git" ]; then
    if [ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
      die "$APP_DIR has local changes, so it cannot be updated; commit or discard them, or pick another --dir"
    fi
    REPO_URL=$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || echo "$REPO_URL")
    pick_ref
    say "Updating $APP_DIR to $REF"
    git -C "$APP_DIR" fetch --quiet --tags --force origin </dev/null || die "git fetch failed in $APP_DIR; not installing an old checkout"
    checkout_ref "$APP_DIR"
  elif [ -f "$APP_DIR/server.ts" ]; then
    say "Using $APP_DIR (not a git clone, so not updating it)"
  elif [ -e "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
    die "$APP_DIR exists and is not Overvibe; pick another folder with --dir"
  else
    pick_ref
    say "Downloading Overvibe $REF into $APP_DIR"
    mkdir -p "$(dirname "$APP_DIR")"
    git clone --quiet "$REPO_URL" "$APP_DIR" </dev/null || die "could not clone $REPO_URL"
    checkout_ref "$APP_DIR"
  fi
}

build_app() {
  mkdir -p "$LOG_DIR"
  say "Installing packages and building the UI (log: $LOG_DIR/install.log)"
  if ! (cd "$APP_DIR" && "$BUN" install --frozen-lockfile) </dev/null >"$LOG_DIR/install.log" 2>&1; then
    tail -n 20 "$LOG_DIR/install.log" >&2
    die "bun install --frozen-lockfile failed; the full log is $LOG_DIR/install.log"
  fi
  if ! (cd "$APP_DIR" && "$BUN" run build) </dev/null >>"$LOG_DIR/install.log" 2>&1; then
    tail -n 20 "$LOG_DIR/install.log" >&2
    die "the UI build failed; the full log is $LOG_DIR/install.log"
  fi
}

link_cli() {
  mkdir -p "$BIN_DIR"
  bash "$APP_DIR/scripts/install-cli.sh" "$BIN_DIR" | grep -v '^note: ' | sed 's/^/  /'
}

# ~/.local/bin on PATH: offer to add it to the shell profile once, else print the line
path_setup() {
  case ":$PATH:" in *":$BIN_DIR:"*) return 0 ;; esac
  case $BIN_DIR in "$HOME"/*) shown="\$HOME${BIN_DIR#"$HOME"}" ;; *) shown=$BIN_DIR ;; esac
  line="export PATH=\"$shown:\$PATH\""
  # a Mac terminal opens login shells; a Linux one opens interactive shells, which read the rc file
  case ${SHELL:-}:$OS_ in
    */zsh:Darwin) profile=$HOME/.zprofile ;;
    */bash:Darwin) profile=$HOME/.bash_profile ;;
    */zsh:*) profile=$HOME/.zshrc ;;
    */bash:*) profile=$HOME/.bashrc ;;
    *) profile=$HOME/.profile ;;
  esac
  if [ -f "$profile" ] && grep -qxF "$line" "$profile"; then
    say "$BIN_DIR is already added in $profile; open a new terminal to use overvibe"
  elif ask "$BIN_DIR is not on your PATH. Add it to $profile?"; then
    printf '\n# added by the Overvibe installer\n%s\n' "$line" >>"$profile"
    say "Added $BIN_DIR to PATH in $profile; open a new terminal to use overvibe"
  else
    say "$BIN_DIR is not on your PATH. To use overvibe, add this line to $profile:"
    say "  $line"
  fi
}

check_clis() {
  missing=
  for t in claude codex agy; do
    p=$(cli_bin "$t")
    if [ -n "$p" ]; then say "  found $t ($p)"; else missing="$missing $t"; fi
  done
  for t in $missing; do
    case $t in
      claude) say "  missing claude: Overvibe's main tool. Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash" ;;
      codex) if [ "$OS_" = Darwin ]; then say "  missing codex (optional): brew install codex, or npm i -g @openai/codex"; else say "  missing codex (optional): npm i -g @openai/codex"; fi ;;
      agy) say "  missing agy (optional): the Antigravity CLI" ;;
    esac
  done
}

# the login service's PATH: where bun, tmux and the CLIs live, then the PATH this ran with (launchd's and
# systemd's own are bare)
service_path() {
  p="$BIN_DIR:$(dirname "$BUN"):$(dirname "$TMUX_")"
  for t in claude codex agy git; do c=$(cli_bin "$t"); [ -n "$c" ] && p="$p:$(dirname "$c")"; done
  printf '%s' "$p:/opt/homebrew/bin:/usr/local/bin:$PATH:/usr/bin:/bin:/usr/sbin:/sbin" | tr ':' '\n' | awk 'NF && !seen[$0]++' | paste -sd: -
}
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# a systemd unit value: % is systemd's specifier sign, so it is doubled
unit_esc() { printf '%s' "$1" | sed 's/%/%%/g'; }

# Linux: the systemd --user unit (written the same way under --no-service, where systemd never reads it)
write_unit() {
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
  envs="Environment=\"DECK_PORT=$PORT\"
Environment=\"PATH=$(unit_esc "$(service_path)")\"
Environment=\"LANG=$(unit_esc "${LANG:-C.UTF-8}")\""
  for k in OVERVIBE_DATA_DIR OVERVIBE_TMUX_SOCKET OVERVIBE_ACCOUNTS_DIR OVERVIBE_CODEX_ACCOUNTS_DIR DECK_WORK_ROOT DISPLAY WAYLAND_DISPLAY; do
    eval "v=\${$k:-}"
    [ -n "$v" ] && envs="$envs
Environment=\"$k=$(unit_esc "$v")\""
  done
  cat >"$PLIST.tmp" <<EOF
# Overvibe's server on 127.0.0.1:$PORT, written by install.sh (run it again to update this file)
[Unit]
Description=Overvibe (local web UI for Claude Code, Codex and agy)

[Service]
Type=simple
WorkingDirectory=$(unit_esc "$APP_DIR")
ExecStart="$(unit_esc "$BUN")" server.ts
$envs
Restart=on-failure
RestartSec=10
# stop only the server: the tmux server it started holds every session, which must keep running
KillMode=process
StandardOutput=append:$(unit_esc "$LOG")
StandardError=append:$(unit_esc "$LOG")

[Install]
WantedBy=default.target
EOF
  mv "$PLIST.tmp" "$PLIST"
}

write_service() { if [ "$OS_" = Darwin ]; then write_plist; else write_unit; fi; }

write_plist() {
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
  envs="    <key>DECK_PORT</key><string>$PORT</string>
    <key>PATH</key><string>$(xml "$(service_path)")</string>
    <key>LANG</key><string>$(xml "${LANG:-en_US.UTF-8}")</string>"
  for k in OVERVIBE_DATA_DIR OVERVIBE_TMUX_SOCKET OVERVIBE_ACCOUNTS_DIR OVERVIBE_CODEX_ACCOUNTS_DIR DECK_WORK_ROOT; do
    eval "v=\${$k:-}"
    [ -n "$v" ] && envs="$envs
    <key>$k</key><string>$(xml "$v")</string>"
  done
  cat >"$PLIST.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$BUN")</string>
    <string>server.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$APP_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
$envs
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST.tmp" >/dev/null || { rm -f "$PLIST.tmp"; die "could not write a valid $PLIST"; }
  mv "$PLIST.tmp" "$PLIST"
}

# --no-service: a login service from an earlier install would start a second server at next login; remove it
remove_old_agent() {
  [ -f "$AGENT_PLIST" ] || return 0
  if [ "$OS_" = Darwin ]; then "$LAUNCHCTL" bootout "gui/$UID_/$LABEL" >/dev/null 2>&1 || true
  else "$SYSTEMCTL" --user disable --now "$UNIT" >/dev/null 2>&1 || true; fi
  rm -f "$AGENT_PLIST"
  if [ "$OS_" = Linux ]; then "$SYSTEMCTL" --user daemon-reload >/dev/null 2>&1 || true; fi
  say "Removed the login service an earlier install left ($AGENT_PLIST): --no-service means nothing starts at login"
}

# ---------- service ----------
start_direct() {
  mkdir -p "$LOG_DIR"
  (umask 077 && mkdir -p "$DATA_DIR") # private, as the server would make it
  [ -n "${BUN:-}" ] || BUN=$(bun_bin)
  [ -n "$BUN" ] || die "Bun is not installed (run the installer)"
  (
    cd "$APP_DIR" || exit 1
    DECK_PORT=$PORT nohup "$BUN" server.ts >>"$LOG" 2>&1 </dev/null &
    echo $! >"$PIDFILE"
  )
}

start_agent() {
  if [ "$OS_" = Linux ]; then
    "$SYSTEMCTL" --user daemon-reload || die "systemctl --user daemon-reload failed"
    "$SYSTEMCTL" --user enable --quiet "$UNIT" 2>/dev/null || die "systemctl --user could not enable $UNIT"
    "$SYSTEMCTL" --user restart "$UNIT" || die "systemctl --user could not start $UNIT (journalctl --user -u $UNIT, and $LOG)"
    return 0
  fi
  "$LAUNCHCTL" bootout "gui/$UID_/$LABEL" >/dev/null 2>&1 || true
  i=0
  until "$LAUNCHCTL" bootstrap "gui/$UID_" "$PLIST" 2>/dev/null; do
    i=$((i + 1))
    [ $i -ge 10 ] && die "launchctl could not load $PLIST (see $LOG)"
    sleep 0.5
  done
}

# up means: /api/health on the port names Overvibe, and login-url points at this port
wait_up() {
  i=0
  until answering && login_matches; do
    i=$((i + 1))
    [ $i -ge 60 ] && die "Overvibe did not answer on $URL/api/health within 30 seconds; its log is $LOG"
    sleep 0.5
  done
}
login_matches() { [ -f "$DATA_DIR/login-url" ] && grep -q "^http://127\.0\.0\.1:$PORT/" "$DATA_DIR/login-url" 2>/dev/null; }

stop_ours() {
  if agent_loaded; then
    if [ "$OS_" = Darwin ]; then "$LAUNCHCTL" bootout "gui/$UID_/$LABEL" >/dev/null 2>&1 || true
    else "$SYSTEMCTL" --user stop "$UNIT" >/dev/null 2>&1 || true; fi
    stopped=agent
  fi
  p=$(direct_pid)
  if [ -n "$p" ]; then
    kill "$p" 2>/dev/null || true
    i=0; while kill -0 "$p" 2>/dev/null && [ $i -lt 20 ]; do sleep 0.25; i=$((i + 1)); done
    rm -f "$PIDFILE"; stopped=direct
  fi
}

# start (or restart) the server: the login agent if it is installed, else directly
service_up() {
  restart=${1:-}
  refuse_foreign
  if answering && ! ours_or_free; then
    say "Overvibe is already running on $URL, started outside this installer (pid $(listener_pid)), for example a dev server; leaving it as it is."
    return 0
  fi
  if answering && [ "$restart" != restart ]; then say "Overvibe is running on $URL"; return 0; fi
  stopped=; stop_ours
  if [ "$NO_LAUNCHD" != 1 ] && [ -f "$PLIST" ]; then start_agent; else start_direct; fi
  wait_up
  say "Overvibe is running on $URL"
}

# the browser only goes to a server that says it is Overvibe, with a login link made for this port
open_page() {
  [ "$NO_OPEN" = 1 ] && return 0
  answering || die "no Overvibe server answers on $URL; not opening the browser (overvibe up)"
  login_matches || die "the login link in $DATA_DIR/login-url is not for port $PORT; not opening it (restart the server: overvibe down && overvibe up)"
  # the link holds the token: hand it to the browser, never to the terminal
  if [ "$OS_" = Darwin ]; then
    open "$(cat "$DATA_DIR/login-url")" >/dev/null 2>&1 || die "could not open the browser; the login link is in $DATA_DIR/login-url"
  elif [ "$IS_WSL" = 1 ] && command -v wslview >/dev/null 2>&1; then
    wslview "$(cat "$DATA_DIR/login-url")" >/dev/null 2>&1 || { no_browser; return 0; }
  elif [ "$IS_WSL" = 1 ] && command -v explorer.exe >/dev/null 2>&1; then
    # the Windows default browser; explorer.exe exits 1 even when it worked, so its status says nothing.
    # Windows reaches this server through WSL's localhost forwarding (it still listens on 127.0.0.1 only)
    explorer.exe "$(cat "$DATA_DIR/login-url")" >/dev/null 2>&1 || true
  elif { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; } && command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$(cat "$DATA_DIR/login-url")" >/dev/null 2>&1 || { no_browser; return 0; }
  else
    no_browser; return 0
  fi
  say "Opened Overvibe in your browser, logged in."
}
# Linux with no browser to hand the link to (a terminal without a desktop): say where the link is, never print it
no_browser() {
  say "Could not open a browser from here. The login link is in $DATA_DIR/login-url: open it in a browser on this computer."
  say "It holds your token, so do not paste it anywhere else."
}

# ---------- commands ----------
do_install() {
  check_os
  say "Installing Overvibe"
  refuse_foreign
  [ "$NO_LAUNCHD" = 1 ] && [ "$NO_SYSTEMD" != 1 ] && remove_old_agent
  linux_packages
  ensure_git
  ensure_bun
  ensure_tmux
  fetch_app
  build_app
  say "Linking the CLI into $BIN_DIR"
  link_cli
  path_setup
  say "Agent CLIs:"
  check_clis
  if answering && ! ours_or_free; then
    say "Overvibe already runs on $URL outside this installer (pid $(listener_pid)), for example a dev server; not adding a login service on that port."
    say "Stop it and run this again to get the login service, or pick another port with --port."
    open_page
    say "Installed Overvibe $(version_of "$APP_DIR") in $APP_DIR"
    return 0
  fi
  write_service
  if [ "$NO_SYSTEMD" = 1 ]; then
    say "No systemd user session here (as on WSL without systemd, or in a container): starting the server directly."
    say "It does not start at login; run overvibe up after a restart. Settings kept in $PLIST."
  elif [ "$NO_LAUNCHD" = 1 ]; then
    say "No login service (--no-service): settings kept in $PLIST, which is never loaded at login; starting the server directly"
  elif [ "$OS_" = Darwin ]; then
    say "Login agent: $PLIST (starts the server at login)"
  else
    say "Login service: $PLIST (systemd --user; starts the server when you log in)"
  fi
  service_up restart
  open_page
  say ""
  say "Installed Overvibe $(version_of "$APP_DIR") in $APP_DIR"
  say "overvibe open brings the page back, overvibe doctor checks the setup, overvibe down stops the server."
  say "Security: agents run real shell commands in the folders you open. Only open repos you trust. More: https://overvibe.dev/security"
}

# overvibe update [T1112-119]: the installer's own update path (fetch, the newest tag, bun install, build, restart)
# for the app the installer put in ~/.overvibe/app, or the --dir given. A clone someone runs by hand is never
# moved to a tag behind their back: they get the git pull to run instead.
do_update() {
  if [ "${DIR_GIVEN:-}" != 1 ] && [ -z "${OVERVIBE_DIR:-}" ]; then
    APP_DIR=$HOME/.overvibe/app
    if wd=$(svc_value dir) && [ -n "$wd" ] && [ -f "$wd/server.ts" ] && [ "$wd" != "$APP_DIR" ]; then
      # the login service runs a folder of its own: update it only when it sits on a tag the installer checked out
      if git -C "$wd" symbolic-ref -q HEAD >/dev/null 2>&1; then
        die "the server runs from $wd, a checkout on a branch, so update leaves it alone; update it with: git -C \"$wd\" pull"
      fi
      APP_DIR=$wd
    fi
  fi
  case $APP_DIR in "~"*) APP_DIR=$HOME${APP_DIR#\~} ;; esac
  if [ ! -d "$APP_DIR/.git" ]; then
    [ -n "$HERE" ] && [ -d "$HERE/.git" ] && die "no installed Overvibe in $APP_DIR; this one runs from a checkout, so update it with: git -C \"$HERE\" pull"
    die "no installed Overvibe in $APP_DIR; install it with: curl -fsSL https://overvibe.dev/install.sh | sh"
  fi
  say "Updating Overvibe $(version_of "$APP_DIR") in $APP_DIR"
  NO_OPEN=1
  do_install
}

do_uninstall() {
  stopped=; stop_ours
  [ -n "$stopped" ] && say "Stopped the Overvibe server"
  if [ "$OS_" = Linux ] && [ "$NO_LAUNCHD" != 1 ]; then "$SYSTEMCTL" --user disable --quiet "$UNIT" >/dev/null 2>&1 || true; fi
  if [ -f "$PLIST" ]; then rm -f "$PLIST"; say "Removed $PLIST"; fi
  if [ "$OS_" = Linux ] && [ "$NO_LAUNCHD" != 1 ]; then "$SYSTEMCTL" --user daemon-reload >/dev/null 2>&1 || true; fi
  for n in overvibe ov deck; do
    at=$BIN_DIR/$n
    [ -L "$at" ] || continue
    case $(readlink "$at") in "$APP_DIR"/bin/*) rm -f "$at"; say "Removed $at" ;; esac
  done
  say "Kept: your sessions and transcripts, $DATA_DIR, and the app in $APP_DIR."
  say "Sessions already running stay up in tmux. To delete the app too: rm -rf \"$APP_DIR\""
}

do_down() {
  stopped=; stop_ours
  case $stopped in
    agent) say "Stopped Overvibe (the login service starts it again at next login; overvibe up starts it now). Sessions keep running in tmux." ;;
    direct) say "Stopped Overvibe. Sessions keep running in tmux." ;;
    *)
      if answering; then say "Overvibe on $URL was not started by overvibe up (pid $(listener_pid)); stop it where it runs."
      elif port_taken; then say "Overvibe is not running; port $PORT is held by something else (pid $(listener_pid || true))."
      else say "Overvibe is not running on $URL"; fi ;;
  esac
}

do_open() {
  answering || service_up
  open_page
}

do_doctor() {
  bad=0
  ok() { say "ok    $*"; }
  no() { say "FAIL  $*"; bad=1; }
  hm() { say "warn  $*"; }
  case $OS_ in
    Darwin) ok "macOS $(sw_vers -productVersion 2>/dev/null)" ;;
    Linux)
      d=$(. /etc/os-release 2>/dev/null && printf "%s" "${PRETTY_NAME:-${NAME:-}}") || d=
      ok "Linux${d:+ ($d)}$([ "$IS_WSL" = 1 ] && printf ', WSL')" ;;
    *) no "$OS_ is not supported (macOS or Linux; on Windows use WSL2)" ;;
  esac
  b=$(bun_bin); [ -n "$b" ] && ok "bun $("$b" --version 2>/dev/null) ($b)" || no "bun missing (https://bun.sh)"
  if [ "$OS_" = Darwin ]; then th="brew install tmux"; else th=$(pkg_cmd tmux); fi
  t=$(tmux_bin); [ -n "$t" ] && ok "$("$t" -V 2>/dev/null) ($t)" || no "tmux missing ($th)"
  command -v git >/dev/null 2>&1 && ok "git" || hm "git missing (needed to install and update)"
  if [ -f "$APP_DIR/server.ts" ]; then ok "app $(version_of "$APP_DIR") in $APP_DIR"; else no "no app in $APP_DIR"; fi
  [ -d "$APP_DIR/node_modules" ] && ok "packages installed" || no "packages missing: cd \"$APP_DIR\" && bun install"
  [ -f "$APP_DIR/dist/index.html" ] && ok "UI built" || no "UI not built: cd \"$APP_DIR\" && bun run build"
  for n in overvibe ov; do
    at=$BIN_DIR/$n
    if [ -L "$at" ]; then ok "$n -> $(readlink "$at")"
    elif [ -e "$at" ]; then hm "$at exists and is not an Overvibe link"
    elif [ $n = overvibe ]; then no "$at missing (sh \"$APP_DIR/install.sh\" or bun run install-cli)"
    else hm "no ov link (another ov may be on PATH; use overvibe)"; fi
  done
  case ":$PATH:" in *":$BIN_DIR:"*) ok "$BIN_DIR is on PATH" ;; *) hm "$BIN_DIR is not on PATH" ;; esac
  if [ "$NO_SYSTEMD" = 1 ]; then hm "no systemd user session: the server does not start at login (overvibe up starts it)"
  elif [ "$NO_LAUNCHD" = 1 ]; then hm "login service checks skipped (--no-service)"
  elif [ "$OS_" = Linux ]; then
    if agent_loaded; then ok "login service running ($UNIT, pid $(agent_pid || echo none))"
    elif [ -f "$PLIST" ]; then hm "login service installed but not running (overvibe up)"
    else hm "no login service (the server does not start at login; run the installer)"; fi
    "$SYSTEMCTL" --user is-enabled --quiet "$UNIT" 2>/dev/null || { [ -f "$PLIST" ] && hm "$UNIT is not enabled, so it does not start at login (run the installer)"; } || true
  elif agent_loaded; then ok "login agent loaded ($LABEL, pid $(agent_pid || echo none))"
  elif [ -f "$PLIST" ]; then hm "login agent installed but not loaded (overvibe up)"
  else hm "no login agent (the server does not start at login; run the installer)"; fi
  if answering; then
    ok "server on $URL: $(health)"
    ours_or_free || hm "the server on $URL was started outside overvibe up (pid $(listener_pid))"
    login_matches && ok "login link is for port $PORT" || hm "login link is not for port $PORT (overvibe down && overvibe up)"
  elif port_taken; then no "port $PORT is held by something that is not Overvibe (pid $(listener_pid || true))"
  else no "server not answering on $URL (overvibe up)"; fi
  if [ -f "$DATA_DIR/token" ]; then
    # GNU stat (Linux) or BSD stat (macOS)
    m=$(stat -c '%a' "$DATA_DIR/token" 2>/dev/null || stat -f '%Lp' "$DATA_DIR/token" 2>/dev/null || true)
    [ "$m" = 600 ] && ok "token file is private (600)" || hm "token file mode is $m; chmod 600 \"$DATA_DIR/token\""
  else hm "no token yet (the server makes one on first start)"; fi
  for c in claude codex agy; do
    p=$(cli_bin "$c")
    if [ -n "$p" ]; then ok "$c ($p)"; elif [ $c = claude ]; then hm "claude missing: curl -fsSL https://claude.ai/install.sh | bash"; else say "-     $c not installed (optional)"; fi
  done
  return $bad
}

case $CMD in
  install) do_install ;;
  update) do_update ;;
  uninstall) do_uninstall ;;
  up) service_up ;;
  down) do_down ;;
  open) do_open ;;
  doctor) do_doctor ;;
esac
}
