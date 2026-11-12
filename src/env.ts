import { homedir } from 'node:os'
import { join } from 'node:path'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'

export const HOME = homedir()
const expandHome = (p: string) => (p === '~' ? HOME : p.startsWith('~/') ? join(HOME, p.slice(2)) : p)
/**
 * A second instance (a demo for screenshots, a test) runs beside the main one with its own state:
 *   OVERVIBE_DATA_DIR      config and state folder (token, login-url, sessions.json...); default ~/.config/overvibe
 *                          (~/.config/agent-deck on installs from before the rename, see dataDirFor)
 *   OVERVIBE_TMUX_SOCKET   tmux socket name (tmux -L); default agent-deck
 *   OVERVIBE_ACCOUNTS_DIR  where extra Claude accounts live; default ~/.claude-accounts
 *   OVERVIBE_CODEX_ACCOUNTS_DIR  where extra Codex accounts live; default ~/.codex-accounts
 *   OVERVIBE_SCOPE         a folder: list only sessions, messages and questions from folders under it
 *   OVERVIBE_DEMO=1        show account emails as <account>@example.com
 *   OVERVIBE_REMOTE_CONTROL=0  start Claude without --remote-control (no live session link on screen, for captures)
 * The port is DECK_PORT (server) and OVERVIBE_PORT or DECK_PORT (the overvibe CLI).
 */
/**
 * The config folder [T1110-80]: ~/.config/overvibe for new installs. An install from before the rename
 * keeps ~/.config/agent-deck where it is (it holds the token, sessions.json, the skills library that
 * ~/.claude/skills links point into, router.ts...), and ~/.config/overvibe becomes a link to it, so the
 * documented paths work on both. Nothing is moved: a move under a running server or running sessions
 * could lose a write or break a link, and a link costs nothing. bin/overvibe, install.sh and
 * desktop/main.cjs pick the folder the same way.
 */
export function dataDirFor(home: string, env: Record<string, string | undefined> = process.env): string {
  if (env.OVERVIBE_DATA_DIR) return env.OVERVIBE_DATA_DIR === '~' ? home : env.OVERVIBE_DATA_DIR.startsWith('~/') ? join(home, env.OVERVIBE_DATA_DIR.slice(2)) : env.OVERVIBE_DATA_DIR
  const neu = join(home, '.config', 'overvibe')
  const old = join(home, '.config', 'agent-deck')
  const realDir = (p: string) => {
    try {
      const st = lstatSync(p)
      return st.isDirectory() && !st.isSymbolicLink()
    } catch {
      return false
    }
  }
  // the old folder wins while it is in use (it has the token) or the new one is not a real folder yet
  if (realDir(old) && (existsSync(join(old, 'token')) || !realDir(neu))) return old
  return neu
}
/** On an old install, ~/.config/overvibe -> agent-deck (relative link), so the new path in the docs works. */
export function linkNewName(home: string, dir: string) {
  const neu = join(home, '.config', 'overvibe')
  if (dir !== join(home, '.config', 'agent-deck')) return
  try {
    lstatSync(neu)
  } catch {
    try {
      symlinkSync('agent-deck', neu)
    } catch {}
  }
}
export const DATA_DIR = dataDirFor(HOME)
export const ACCOUNTS_DIR = expandHome(process.env.OVERVIBE_ACCOUNTS_DIR || join(HOME, '.claude-accounts'))
export const CODEX_ACCOUNTS_DIR = expandHome(process.env.OVERVIBE_CODEX_ACCOUNTS_DIR || join(HOME, '.codex-accounts'))
export const TMUX_SOCKET = process.env.OVERVIBE_TMUX_SOCKET || 'agent-deck'
export const SCOPE = process.env.OVERVIBE_SCOPE ? expandHome(process.env.OVERVIBE_SCOPE).replace(/\/+$/, '') : null
/** true when the folder is inside OVERVIBE_SCOPE (always true without one) */
export const inScope = (cwd: string | null | undefined) => {
  if (!SCOPE) return true
  if (!cwd) return false
  const abs = expandHome(cwd)
  return abs === SCOPE || abs.startsWith(SCOPE + '/')
}
export const DEMO = process.env.OVERVIBE_DEMO === '1'
export const REMOTE_CONTROL = process.env.OVERVIBE_REMOTE_CONTROL !== '0'
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
if (!process.env.OVERVIBE_DATA_DIR) linkNewName(HOME, DATA_DIR)

/**
 * Local setup, outside the repo: ~/.config/overvibe/config.json (all keys optional).
 *   workRoot       the folder your projects live under (folder search, drop search, TASKS.md lookup stop).
 *                  Env DECK_WORK_ROOT wins; default ~/Work if it exists, else your home folder.
 *   codexWritable  extra folders Codex sessions may write to, on top of the session folder and workRoot.
 *   jobFolders     names of hidden folders (".<name>/") where background runners start claude; their
 *                  sessions are not listed as yours.
 */
type LocalConfig = { workRoot?: string; codexWritable?: string[]; jobFolders?: string[] }
function readConfig(): LocalConfig {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf8')) ?? {}
  } catch {
    return {}
  }
}
export const CONFIG = readConfig()
const expand = (p: string) => (p === '~' ? HOME : p.startsWith('~/') ? join(HOME, p.slice(2)) : p)
/** the work root with no config.json workRoot and no env: ~/Work if it exists, else home */
export const defaultWorkRoot = () => expand(existsSync(join(HOME, 'Work')) ? '~/Work' : '~')
/** DECK_WORK_ROOT, when set; it wins over config.json */
export const WORK_ROOT_ENV = process.env.DECK_WORK_ROOT ? expand(process.env.DECK_WORK_ROOT) : null
/** a live binding: setWorkRoot changes it, and every module that imports it sees the new value */
export let WORK_ROOT = WORK_ROOT_ENV || (CONFIG.workRoot ? expand(CONFIG.workRoot) : defaultWorkRoot())

/**
 * Save workRoot to config.json (null removes the key: back to the default) and apply it now, unless
 * DECK_WORK_ROOT is set. The file is read fresh so keys written by hand since startup are kept.
 * The caller validates the folder (folders.ts setWorkRootChecked).
 */
export function setWorkRoot(abs: string | null) {
  const file = join(DATA_DIR, 'config.json')
  const cur = (() => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) ?? {}
    } catch (e: any) {
      if (e?.code === 'ENOENT') return {}
      throw new Error("config.json can't be read as JSON; fix it by hand first")
    }
  })()
  if (abs) cur.workRoot = tildify(abs)
  else delete cur.workRoot
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
  CONFIG.workRoot = cur.workRoot
  if (!WORK_ROOT_ENV) WORK_ROOT = abs ?? defaultWorkRoot()
}

export const CLAUDE_BIN = Bun.which('claude') ?? join(HOME, '.local', 'bin', 'claude')
export const CODEX_BIN = Bun.which('codex') ?? join(HOME, '.local', 'bin', 'codex')
export const AGY_BIN = Bun.which('agy') ?? join(HOME, '.local', 'bin', 'agy')
export type Tool = 'claude' | 'codex' | 'agy'
export const TOOLS: Tool[] = ['claude', 'codex', 'agy']
/** the first 200 bytes of a file (a shim says so on its second line; never read a whole tmux binary) */
function head200(p: string): string {
  const fd = openSync(p, 'r')
  try {
    const b = Buffer.alloc(200)
    return b.toString('utf8', 0, readSync(fd, b, 0, 200, 0))
  } finally {
    closeSync(fd)
  }
}
/** an Overvibe tmux shim (src/tmuxshim.ts), which a server started from inside a session finds first on PATH */
export function isTmuxShim(p: string): boolean {
  try {
    return head200(p).includes('# overvibe-tmux-shim')
  } catch {
    return false
  }
}
/**
 * The real tmux: OVERVIBE_TMUX_BIN (every session gets it), else the first tmux on PATH that is not an Overvibe
 * shim [T1111-18], else where Homebrew (Mac, Linuxbrew) or the distro puts it; a launchd or systemd PATH can be bare.
 */
export function realTmux(env: Record<string, string | undefined> = process.env): string {
  const ok = (p: string | undefined): p is string => !!p && p.startsWith('/') && existsSync(p) && !isTmuxShim(p)
  if (ok(env.OVERVIBE_TMUX_BIN)) return env.OVERVIBE_TMUX_BIN
  const dirs = (env.PATH ?? '').split(':').filter(Boolean)
  const fallback = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin']
  return [...dirs, ...fallback].map((d) => join(d, 'tmux')).find(ok) ?? '/opt/homebrew/bin/tmux'
}
export const TMUX_BIN = realTmux()

/**
 * The environment for everything the deck starts. When the server is launched from inside a Claude
 * Code session it inherits that session's variables; a child `claude` would think it is nested.
 */
export function cleanEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_CONFIG_DIR') continue
    // a server started from inside a session carries that session's identity; nothing it spawns may inherit it
    // (a plain shell would otherwise act as that session). Sessions get their own through `extra`.
    if (k === 'DECK_SESSION' || k === 'OVERVIBE_SESSION' || k === 'OVERVIBE_PROOF' || k === 'DECK_PROOF') continue
    env[k] = v
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

export const tildify = (p: string) => (p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p)
export const untildify = (p: string) => (p === '~' ? HOME : p.startsWith('~/') ? join(HOME, p.slice(2)) : p)
