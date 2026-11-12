// All deck sessions live on their own tmux server (socket "agent-deck"), so they survive the web
// server restarting and never mix with a tmux the owner runs by hand.
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { DATA_DIR, TMUX_BIN, TMUX_SOCKET, cleanEnv, isTmuxShim } from './env'
import { clipboardShell } from './platform'
import { installShim, pathWithShim } from './tmuxshim'
import { splitSlash } from './slashpaste'

const CONF = join(DATA_DIR, 'tmux.conf')
const COPY = clipboardShell()
writeFileSync(
  CONF,
  [
    'set -g status off',
    'set -g mouse on',
    'set -g history-limit 50000',
    'set -g escape-time 0',
    'set -g default-terminal "tmux-256color"',
    'set -ga terminal-overrides ",xterm-256color:RGB"',
    'set -g allow-passthrough on',
    // copy-on-select: tmux (and Claude Code inside it) send copied text as OSC 52; pass it to the
    // browser terminal, whose clipboard addon puts it on the Mac clipboard
    'set -g set-clipboard on',
    'set -as terminal-features ",xterm-256color:clipboard"',
    // and straight onto the system clipboard too: OSC 52 needs a focused browser tab, pbcopy does not
    // (copy-pipe with no command, used by every mouse binding below and tmux's defaults, runs this);
    // on Linux and WSL the command src/platform.ts finds, or none (OSC 52 only) [T1111-8]
    ...(COPY ? [`set -g copy-command ${JSON.stringify(COPY)}`] : []),
    // no tmux right-click menu: the page handles right-click
    'unbind -n MouseDown3Pane',
    'unbind -n M-MouseDown3Pane',
    'unbind -n MouseDown3Status',
    'unbind -n MouseDown3StatusLeft',
    // releasing a mouse selection copies it and leaves copy mode, like a normal terminal
    'bind -T copy-mode MouseDragEnd1Pane send -X copy-pipe-and-cancel',
    'bind -T copy-mode-vi MouseDragEnd1Pane send -X copy-pipe-and-cancel',
    // a window the size of the latest client, so one browser tab never squeezes another
    'set -g window-size latest',
    'set -g aggressive-resize on',
  ].join('\n') + '\n',
)

export const TMUX = [TMUX_BIN, '-L', TMUX_SOCKET, '-f', CONF]
// the tmux guard's shim (src/tmuxshim.ts), rewritten at each start so it names this tmux and socket
export const SHIM = installShim(DATA_DIR, TMUX_BIN, TMUX_SOCKET)
// the tmux server outlives this process: load the config into it again (no-op when no server runs)
Bun.spawn([...TMUX, 'source-file', CONF], { env: cleanEnv(), stdout: 'ignore', stderr: 'ignore' })

async function run(args: string[], extra: Record<string, string> = {}): Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn([...TMUX, ...args], { env: cleanEnv(extra), stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { ok: (await p.exited) === 0, out, err }
}

/** `path` is the active pane's current folder (a shell's `cd` moves it; agents stay where they started) */
export type Pane = { name: string; created: number; attached: number; pid: number; activity: number; path: string; /** the pane's foreground command (pane_current_command) */ cmd: string }

// the field separator in -F formats: printable, since tmux 3.3 (Debian 12) prints a tab in a format as "_" [T1111-8]
const SEP = '|~|'
const fmt = (...f: string[]) => f.map((x) => `#{${x}}`).join(SEP)

export async function listSessions(): Promise<Pane[]> {
  const r = await run(['list-sessions', '-F', fmt('session_name', 'session_created', 'session_attached', 'pane_pid', 'window_activity', 'pane_current_command', 'pane_current_path')])
  if (!r.ok) return [] // no server yet
  return r.out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, created, attached, pid, activity, cmd, ...path] = l.split(SEP)
      return { name: name!, created: +created! * 1000, attached: +attached!, pid: +pid!, activity: +activity! * 1000, cmd: cmd ?? '', path: path.join(SEP) }
    })
}

/** Start `argv` in a new detached session. argv runs directly (no shell), so nothing needs quoting. */
export async function newSession(name: string, cwd: string, argv: string[], env: Record<string, string> = {}) {
  // the tmux guard [T1111-18]: the shim first on PATH, and the real tmux for overvibe (bin/overvibe) to use
  // and ZDOTDIR on its zsh wrappers, since a zsh login shell puts Homebrew's tmux back in front (src/tmuxshim.ts)
  // the user's own zsh folder; a server started inside a session sees a wrapper folder as ZDOTDIR
  const z = process.env.ZDOTDIR
  const userZ = process.env.OVERVIBE_USER_ZDOTDIR || (z && !isTmuxShim(join(z, '.zshenv')) ? z : undefined)
  const guard = {
    PATH: pathWithShim(SHIM.dir, env.PATH ?? process.env.PATH),
    OVERVIBE_TMUX_BIN: TMUX_BIN,
    ZDOTDIR: SHIM.zdotdir,
    ...(userZ ? { OVERVIBE_USER_ZDOTDIR: userZ } : {}),
  }
  const e = Object.entries({ ...env, ...guard }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  // PATH goes on the tmux client too: for a client that is not attached, tmux gives the new pane the client's
  // PATH over the -e one
  const r = await run(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...e, '--', ...argv], { PATH: guard.PATH })
  if (!r.ok) throw new Error(`tmux new-session failed: ${r.err.trim()}`)
}

/** Drop a variable from a session's tmux environment (the process keeps its copy), so `tmux show-environment` can't read it. */
export async function forgetEnv(name: string, key: string) {
  await run(['set-environment', '-t', `=${name}`, '-u', key])
}

export async function killSession(name: string) {
  await run(['kill-session', '-t', `=${name}`])
}

/** The last lines on screen, for the sidebar preview. */
export async function capture(name: string, lines = 40): Promise<string> {
  const r = await run(['capture-pane', '-p', '-t', `=${name}:`, '-S', `-${lines}`])
  return r.ok ? r.out : ''
}

/** The visible screen with wrapped lines joined (-J), so a resize does not change the text [T1112-7]. */
export async function captureJoined(name: string): Promise<string | null> {
  const r = await run(['capture-pane', '-p', '-J', '-t', `=${name}:`])
  return r.ok ? r.out : null
}

/** The visible screen with its colours and attributes (-e), so dim placeholder text can be told from typed text. */
export async function captureStyled(name: string): Promise<string | null> {
  const r = await run(['capture-pane', '-e', '-p', '-t', `=${name}:`])
  return r.ok ? r.out : null
}

/** When each session's attached clients last had a key or mouse event (ms; tmux keeps whole seconds), leaving out the clients in `skip` (pids). */
export async function clientActivity(skip: Set<number> = new Set()): Promise<Map<string, number>> {
  const r = await run(['list-clients', '-F', fmt('client_session', 'client_activity', 'client_pid')])
  const out = new Map<string, number>()
  if (!r.ok) return out
  for (const l of r.out.trim().split('\n').filter(Boolean)) {
    const [s, a, pid] = l.split(SEP)
    if (skip.has(+pid!)) continue
    out.set(s!, Math.max(out.get(s!) ?? 0, +a! * 1000))
  }
  return out
}

// A page attaches every session it keeps open, the hidden ones too, and a hidden terminal never
// reports its size, so it would sit at the 120x40 default. Each client starts out ignored for sizing
// (ignore-size) and counts only once its page sends a real size (countSize), so a background tab can
// never shrink the window of the one on screen.
export const attachArgv = (name: string) => [...TMUX, 'attach-session', '-f', 'ignore-size', '-t', `=${name}`]

/** let the client whose process is `pid` size its window (after its page sent a real size) */
export async function countSize(pid: number) {
  // the page's first size can arrive before tmux has the new client registered: look a few times
  for (let i = 0; i < 10; i++) {
    const r = await run(['list-clients', '-F', fmt('client_pid', 'client_name')])
    const name = r.out.split('\n').map((l) => l.split(SEP)).find(([p]) => +p! === pid)?.[1]
    if (name) return void (await run(['refresh-client', '-t', name, '-f', '!ignore-size']))
    await Bun.sleep(100)
  }
}

/**
 * Type text into a session's prompt and press Enter (literal: nothing in it is read as a key name).
 * Codex reads a fast burst of text as a paste and swallows an Enter that follows at once, so wait
 * a moment before Enter, then check the text left the input box and press once more if it did not.
 */
export async function typeInto(name: string, text: string) {
  // "/compact <long note>" pasted whole never runs: type the command name, paste the rest [T1112-132]
  const slash = splitSlash(text)
  if (slash) {
    await typeLiteral(name, slash[0])
    await Bun.sleep(150)
  }
  await pasteText(name, slash ? slash[1] : text)
  await Bun.sleep(350)
  const submit = async () => {
    // Codex ignores Enter while it is working ("tab to queue message"): queue with Tab instead
    const screen = await capture(name, 6)
    await run(['send-keys', '-t', `=${name}:`, /tab to queue message/i.test(screen) ? 'Tab' : 'Enter'])
  }
  await submit()
  const tail = text.replace(/\s+/g, ' ').trim().slice(-24)
  for (let i = 0; i < 2 && tail.length >= 8; i++) {
    await Bun.sleep(700)
    // still sitting in the input box (the last lines, above the status line): submit again.
    // A long paste shows as a placeholder instead of the text ("[Pasted text #1 +N lines]" in Claude Code, "[Pasted Content 1234 chars]" in Codex).
    const bottom = (await capture(name, 8)).replace(/\s+/g, ' ')
    if (!bottom.includes(tail) && !/\[Pasted (text|Content) ?#?\d+/i.test(bottom)) break
    await submit()
  }
}

/**
 * Put text into a session's input as one bracketed paste, not as typed keys. A long burst of typed
 * characters is split by Claude Code and Codex into "typing" and "a paste", and the head of a long
 * message could be lost that way (2026-11-11: an overvibe send arrived without its header). A paste
 * arrives whole; newlines stay newlines inside it (-r), and the buffer is deleted after (-d).
 */
async function pasteText(name: string, text: string) {
  const buf = `ov-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  const p = Bun.spawn([...TMUX, 'load-buffer', '-b', buf, '-'], { env: cleanEnv(), stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' })
  p.stdin.write(text)
  p.stdin.end()
  if ((await p.exited) !== 0) return void (await run(['send-keys', '-t', `=${name}:`, '-l', text]))
  await run(['paste-buffer', '-p', '-r', '-d', '-b', buf, '-t', `=${name}:`])
}

/** Type text literally (no Enter, no key names), as into a menu's "Type something" row. */
export async function typeLiteral(name: string, text: string) {
  await run(['send-keys', '-t', `=${name}:`, '-l', text])
}

/** Press named keys (Up, Down, Enter...) in a session, one at a time so a menu sees each. */
export async function sendKeys(name: string, keys: string[]) {
  for (const k of keys) {
    await run(['send-keys', '-t', `=${name}:`, k])
    await Bun.sleep(40)
  }
}
