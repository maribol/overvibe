// The tmux guard [T1111-18]. Agents inside Overvibe sessions kept driving the deck's tmux server by hand
// (capture-pane, list-sessions, switch-client...) instead of the overvibe CLI: inside a session $TMUX points
// at that server, so a plain `tmux` reaches every session. Every session Overvibe starts gets this folder
// first on PATH; its `tmux` turns the session-driving commands aimed at Overvibe's server into a one-line
// hint naming the overvibe command, and passes everything else (Claude Code's and Codex's own clipboard and
// passthrough calls: load-buffer, display-message, show-options; other tmux servers) to the real tmux.
// OVERVIBE_RAW_TMUX=1 lets a blocked call through (owner only; README, never in the hint).
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** the first line after the shebang: how realTmux() (src/env.ts, bin/overvibe, install.sh) knows a shim */
export const SHIM_MARK = '# overvibe-tmux-shim'

// tmux 3.8's commands and aliases (tmux list-commands), for its unique-prefix matching: "capture-p" and
// "capturep" are capture-pane too. A name missing here (an older or newer tmux) only loses prefix matching.
const COMMANDS =
  'attach-session:attach bind-key:bind break-pane:breakp capture-pane:capturep choose-buffer choose-client choose-tree clear-history:clearhist clear-prompt-history:clearphist clock-mode command-prompt confirm-before:confirm copy-mode customize-mode delete-buffer:deleteb detach-client:detach display-menu:menu display-message:display display-popup:popup display-panes:displayp find-window:findw has-session:has if-shell:if join-pane:joinp kill-pane:killp kill-server kill-session kill-window:killw last-pane:lastp last-window:last link-window:linkw list-buffers:lsb list-clients:lsc list-commands:lscm list-keys:lsk list-panes:lsp list-sessions:ls list-windows:lsw load-buffer:loadb lock-client:lockc lock-server:lock lock-session:locks move-pane:movep move-window:movew new-pane:newp new-session:new new-window:neww next-layout:nextl next-window:next paste-buffer:pasteb pipe-pane:pipep previous-layout:prevl previous-window:prev refresh-client:refresh rename-session:rename rename-window:renamew resize-pane:resizep resize-window:resizew respawn-pane:respawnp respawn-window:respawnw rotate-window:rotatew run-shell:run save-buffer:saveb select-layout:selectl select-pane:selectp select-window:selectw send-keys:send send-prefix server-access set-buffer:setb set-environment:setenv set-hook set-option:set set-window-option:setw show-buffer:showb show-environment:showenv show-hooks show-messages:showmsgs show-options:show show-prompt-history:showphist show-window-options:showw source-file:source split-window:splitw start-server:start suspend-client:suspendc swap-pane:swapp swap-window:swapw switch-client:switchc switch-mode unbind-key:unbind unlink-window:unlinkw wait-for:wait'

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** The shim: POSIX sh, so it starts fast and needs nothing but /bin/sh. */
export function shimScript(realTmux: string, socket: string): string {
  return `#!/bin/sh
${SHIM_MARK} (Overvibe, src/tmuxshim.ts; rewritten on every server start)
# Blocks session-driving tmux commands on Overvibe's own tmux server and names the overvibe command instead.
REAL=\${OVERVIBE_TMUX_BIN:-${q(realTmux)}}
case "$REAL" in */*) [ -x "$REAL" ] || REAL=${q(realTmux)} ;; esac
SOCK=${q(socket)}
[ "$OVERVIBE_RAW_TMUX" = 1 ] && exec "$REAL" "$@"
COMMANDS=${q(COMMANDS)}

# global options: -L name and -S path pick the server; -c (a shell command) and -V run no tmux command
srv_l= srv_s= need= shellcmd= cmd= target= tnext= nextcmd= blocked= btarget=
check() { # $1 a command word: sets blocked to the full command name when it drives sessions
  w=$1 full=
  for e in $COMMANDS; do
    n=\${e%%:*}; a=\${e#*:}
    if [ "$w" = "$n" ] || { [ "$a" != "$e" ] && [ "$w" = "$a" ]; }; then full=$n; break; fi
  done
  if [ -z "$full" ]; then
    hits=0
    for e in $COMMANDS; do n=\${e%%:*}; case "$n" in "$w"*) hits=$((hits + 1)); full=$n ;; esac; done
    [ "$hits" = 1 ] || full=
  fi
  case "$full" in
    capture-pane | send-keys | paste-buffer | list-sessions | list-panes | list-windows | list-clients | \\
    attach-session | switch-client | select-window | select-pane | kill-session | kill-server | kill-pane | kill-window | \\
    new-session | new-window | new-pane | split-window | respawn-pane | respawn-window)
      [ -z "$blocked" ] && blocked=$full ;;
  esac
}
phase=global
for arg in "$@"; do
  if [ "$phase" = global ]; then
    if [ -n "$need" ]; then
      case "$need" in L) srv_l=$arg ;; S) srv_s=$arg ;; c) shellcmd=1 ;; esac
      need=; continue
    fi
    case "$arg" in
      --) phase=cmd; continue ;;
      -?*)
        rest=\${arg#-}
        while [ -n "$rest" ]; do
          c=\${rest%"\${rest#?}"}; rest=\${rest#?}
          case "$c" in
            V) shellcmd=1 ;;
            c | f | L | S | T)
              if [ -n "$rest" ]; then
                case "$c" in L) srv_l=$rest ;; S) srv_s=$rest ;; c) shellcmd=1 ;; esac
              else need=$c; fi
              break ;;
          esac
        done
        continue ;;
    esac
    phase=cmd
  fi
  if [ "$phase" = cmd ] || [ -n "$nextcmd" ]; then
    nextcmd=; phase=args; cmd=1; check "$arg"; tnext=
    [ -n "$blocked" ] && [ -z "$btarget" ] && btarget=-
    continue
  fi
  # inside a command: its -t target (for the hint), and ";" starting the next command
  if [ -n "$tnext" ]; then [ "$btarget" = - ] && btarget=$arg; tnext=; continue; fi
  case "$arg" in
    ';') nextcmd=1; continue ;;
    *'\\;') ;;
    *';') nextcmd=1 ;;
    -t) tnext=1 ;;
    -t?*) [ "$btarget" = - ] && btarget=\${arg#-t} ;;
  esac
done
# no command means new-session
[ -z "$cmd" ] && [ -z "$shellcmd" ] && blocked=new-session
[ -n "$shellcmd" ] && blocked=

# which server: -S path, else -L name, else the one $TMUX points at (inside a session: Overvibe's)
deck=
if [ -n "$srv_s" ]; then
  case "$srv_s" in */"$SOCK" | "$SOCK") deck=1 ;; esac
elif [ -n "$srv_l" ]; then
  [ "$srv_l" = "$SOCK" ] && deck=1
elif [ -n "$TMUX" ]; then
  case "\${TMUX%%,*}" in */"$SOCK") deck=1 ;; esac
fi

if [ -n "$deck" ] && [ -n "$blocked" ]; then
  t=\${btarget#-}; t=\${t#=}; t=\${t%%:*}; t=\${t%%.*}
  case "$t" in '' | '%'* | '@'* | '$'*) t='<session name>' ;; esac
  case "$blocked" in
    capture-pane) use="overvibe peek \\"$t\\"" ;;
    send-keys | paste-buffer) use="overvibe send \\"$t\\" \\"<message>\\"" ;;
    list-*) use='overvibe ls' ;;
    attach-session | switch-client | select-window | select-pane) use="overvibe open \\"$t\\" (shows it on the owner's screen), or overvibe attach \\"$t\\" from a real terminal" ;;
    kill-*) use="overvibe stop \\"$t\\"" ;;
    *) use='overvibe new --cwd <folder> --prompt "<task>"' ;;
  esac
  echo "tmux $blocked does not work on Overvibe's sessions; use: $use" >&2
  exit 1
fi
exec "$REAL" "$@"
`
}

/** Write <dataDir>/shim/tmux and the zsh wrappers in <dataDir>/shim/zsh; returns both folders. */
export function installShim(dataDir: string, realTmux: string, socket: string): { dir: string; zdotdir: string } {
  const dir = join(dataDir, 'shim')
  const zdotdir = join(dir, 'zsh')
  mkdirSync(zdotdir, { recursive: true, mode: 0o700 })
  writeIfChanged(join(dir, 'tmux'), shimScript(realTmux, socket), 0o755)
  for (const f of ZSH_FILES) writeIfChanged(join(zdotdir, f), zshWrapper(f, dir), 0o644)
  return { dir, zdotdir }
}

/**
 * zsh login shells put the shim behind the real tmux: macOS's /etc/zprofile runs path_helper, which rebuilds
 * PATH system folders first, then ~/.zprofile prepends Homebrew (`brew shellenv`). Shell sessions start
 * `zsh -l`, and Codex and agy run their commands in `zsh -lc`. So sessions also get ZDOTDIR pointing at
 * these wrappers (the way VS Code's shell integration does it): each runs the user's own file of the same
 * name (from OVERVIBE_USER_ZDOTDIR, else ~), then puts the shim first on PATH again. ZDOTDIR stays here so
 * shells those shells start are covered too.
 */
const ZSH_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin']
export function zshWrapper(file: string, shimDir: string): string {
  return `# overvibe-tmux-shim zsh wrapper (Overvibe, src/tmuxshim.ts): runs your own ${file}, then keeps
# Overvibe's tmux guard first on PATH [T1111-18]. Your files stay in \${OVERVIBE_USER_ZDOTDIR:-~}.
__ov_zdot=$ZDOTDIR
export OVERVIBE_USER_ZDOTDIR=\${OVERVIBE_USER_ZDOTDIR:-$HOME}
ZDOTDIR=$OVERVIBE_USER_ZDOTDIR
${file === '.zshrc' ? `# /etc/zshrc put the history next to these wrappers: it belongs with yours
[[ $HISTFILE == $__ov_zdot/.zsh_history ]] && HISTFILE=$ZDOTDIR/.zsh_history
` : ''}[[ -r $ZDOTDIR/${file} ]] && builtin source $ZDOTDIR/${file}
OVERVIBE_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__ov_zdot
unset __ov_zdot
path=(${q(shimDir)} \${path:#${q(shimDir)}})
`
}

function writeIfChanged(file: string, text: string, mode: number) {
  let cur = ''
  try {
    cur = readFileSync(file, 'utf8')
  } catch {}
  if (cur === text) return
  // a running session may be reading it: write aside and rename, never truncate in place
  writeFileSync(file + '.tmp', text, { mode })
  chmodSync(file + '.tmp', mode)
  renameSync(file + '.tmp', file)
}

/** PATH with `dir` first and no other copy of it */
export const pathWithShim = (dir: string, path: string | undefined) => [dir, ...(path ?? '').split(':').filter((p) => p && p !== dir)].join(':')
