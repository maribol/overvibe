// CLI updates [T1112-103]. Codex shows its own "Update available" menu at startup, and a session waits on it until
// someone answers, so Overvibe starts Codex with check_for_update_on_startup=false (src/sessions.ts) and checks for
// updates itself instead: the installed version from `--version`, the latest from the same place the CLI's own check
// reads, at most once every 6 hours, cached on disk, with a short timeout and never awaited by a request.
// The flag shows in Settings > Accounts, the setup page and the sidebar footer; Update runs the CLI's own update
// command in a visible terminal row (server.ts), never on its own.
//
// Claude Code updates itself in the background, so it gets a flag only when that is turned off (DISABLE_AUTOUPDATER
// or autoUpdates: false). agy updates itself too, from an update service with no documented API, so it gets none.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODEX_BIN, DATA_DIR, HOME, tildify } from './env'
import { APP_VERSION } from './news'

export type UpdateTool = 'claude' | 'codex'
export type Update = { latest: string; cmd: string; how: string }

/** The first x.y.z in a `--version` line or a release tag ("codex-cli 0.160.0", "2.1.322 (Claude Code)", "rust-v0.167.2"). */
export function parseVersion(s: string | undefined | null): string | null {
  const m = String(s ?? '').match(/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/)
  return m ? m[0] : null
}

/** -1, 0 or 1. A pre-release ("0.168.0-alpha.1") sorts before its release; pre-release parts compare numerically where both are numbers. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const dash = v.indexOf('-')
    const core = dash < 0 ? v : v.slice(0, dash)
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: dash < 0 ? '' : v.slice(dash + 1) }
  }
  const x = split(a), y = split(b)
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) < (y.nums[i] ?? 0) ? -1 : 1
  if (!x.pre && !y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  const p = x.pre.split('.'), q = y.pre.split('.')
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1
    if (q[i] === undefined) return 1
    if (p[i] === q[i]) continue
    const n = Number(p[i]), m = Number(q[i])
    if (!isNaN(n) && !isNaN(m)) return n < m ? -1 : 1
    return p[i]! < q[i]! ? -1 : 1
  }
  return 0
}

/** Newer than what is installed, and a real release (no pre-release offered to someone on a release). */
export const isNewer = (installed: string, latest: string) => !latest.includes('-') && compareVersions(installed, latest) < 0

/** How Codex was installed, from where its binary really lives. The same split Codex's own update check makes. */
export type CodexInstall = 'standalone' | 'npm' | 'bun' | 'pnpm' | 'brew' | 'unknown'
export function codexInstallOf(realPath: string): CodexInstall {
  if (/\/\.codex\/packages\/standalone\//.test(realPath)) return 'standalone'
  if (/\/Caskroom\/codex\//.test(realPath)) return 'brew'
  if (/\/\.bun\/install\/global\//.test(realPath)) return 'bun'
  if (/\/pnpm\//.test(realPath) && realPath.includes('/@openai/codex/')) return 'pnpm'
  if (realPath.includes('/node_modules/@openai/codex/')) return 'npm'
  return 'unknown'
}

/** Where the latest Codex version is read for each install, and the command that updates it. */
export function codexSource(install: CodexInstall): { url: string; pick: (j: any) => string | null; cmd: string; how: string } {
  const gh = { url: 'https://api.github.com/repos/openai/codex/releases/latest', pick: (j: any) => parseVersion(j?.name) ?? parseVersion(j?.tag_name) }
  const npm = { url: 'https://registry.npmjs.org/@openai%2fcodex/latest', pick: (j: any) => parseVersion(j?.version) }
  if (install === 'brew') return { url: 'https://formulae.brew.sh/api/cask/codex.json', pick: (j: any) => parseVersion(j?.version), cmd: 'brew upgrade --cask codex', how: 'Homebrew' }
  if (install === 'npm') return { ...npm, cmd: 'npm install -g @openai/codex@latest', how: 'npm' }
  if (install === 'bun') return { ...npm, cmd: 'bun install -g @openai/codex@latest', how: 'bun' }
  if (install === 'pnpm') return { ...npm, cmd: 'pnpm add -g @openai/codex@latest', how: 'pnpm' }
  // the official install script: `codex update` reruns it the way Codex's own Update now does
  return { ...gh, cmd: 'codex update', how: install === 'standalone' ? 'the Codex install script' : 'codex update' }
}

/** Claude Code's own updater is off: DISABLE_AUTOUPDATER (settings env or this process) or autoUpdates: false. */
export function claudeAutoUpdateOff(settings: any, claudeJson: any, env: Record<string, string | undefined> = process.env): boolean {
  const on = (v: unknown) => v !== undefined && v !== '' && v !== '0' && v !== 'false'
  return on(settings?.env?.DISABLE_AUTOUPDATER) || on(env.DISABLE_AUTOUPDATER) || settings?.autoUpdates === false || claudeJson?.autoUpdates === false
}

const readJson = (p: string) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const realOf = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

const FILE = join(DATA_DIR, 'updates.json')
const EVERY = 6 * 3600_000 // a check at most every 6 hours
const RETRY = 3600_000 // after a failed check, try again in an hour
type Entry = { latest?: string; self?: SelfLatest; src?: string; at: number; ok: boolean }
let cache: Partial<Record<UpdateTool | 'overvibe', Entry>> = readJson(FILE) ?? {}
const running = new Set<UpdateTool | 'overvibe'>()

/** One GET with a 5 s timeout: JSON, or the body as text (Claude Code's release channel answers a bare version). */
async function get(url: string, text: boolean): Promise<any> {
  const r = await fetch(url, { headers: { accept: text ? 'text/plain' : 'application/json', 'user-agent': 'overvibe-update-check' }, signal: AbortSignal.timeout(5000) })
  if (!r.ok) throw new Error(`${r.status}`)
  return text ? r.text() : r.json()
}

/** The latest version for a tool, refreshed in the background when stale; the cached one (or none) right away. */
function latestOf(tool: UpdateTool, url: string, pick: (j: any) => string | null, text = false): string | undefined {
  const e = cache[tool]
  const stale = !e || Date.now() - e.at > (e.ok ? EVERY : RETRY)
  if (stale && !running.has(tool)) {
    running.add(tool)
    void (async () => {
      try {
        const v = pick(await get(url, text))
        cache[tool] = v ? { latest: v, at: Date.now(), ok: true } : { ...(cache[tool] ?? {}), at: Date.now(), ok: false }
      } catch {
        cache[tool] = { ...(cache[tool] ?? {}), at: Date.now(), ok: false }
      } finally {
        running.delete(tool)
        try {
          writeFileSync(FILE, JSON.stringify(cache))
        } catch {}
      }
    })()
  }
  return e?.latest
}

/** The update for a tool given its `--version` line, or null when it is current, unknown or updates itself. Never waits on the network. */
export function updateFor(tool: 'claude' | 'codex' | 'agy', versionLine: string | undefined): Update | null {
  const installed = parseVersion(versionLine)
  if (!installed || tool === 'agy') return null
  if (tool === 'codex') {
    const src = codexSource(codexInstallOf(realOf(CODEX_BIN)))
    const latest = latestOf('codex', src.url, src.pick)
    return latest && isNewer(installed, latest) ? { latest, cmd: src.cmd, how: src.how } : null
  }
  const settings = readJson(join(HOME, '.claude', 'settings.json'))
  if (!claudeAutoUpdateOff(settings, readJson(join(HOME, '.claude.json')))) return null
  // the release channel Claude Code's own updater reads: "latest" unless settings ask for "stable"
  const channel = settings?.autoUpdatesChannel === 'stable' ? 'stable' : 'latest'
  const latest = latestOf('claude', `https://downloads.claude.ai/claude-code-releases/${channel}`, (t) => parseVersion(typeof t === 'string' ? t : ''), true)
  return latest && isNewer(installed, latest) ? { latest, cmd: 'claude update', how: 'claude update' } : null
}

/** After an update ran: check the installed versions again soon, and the latest one on the next look. */
export function forgetUpdate(tool: UpdateTool) {
  delete cache[tool]
}

// ---------- Overvibe itself [T1112-119] ----------
// The same quiet check for Overvibe: its newest GitHub release (else the highest vX.Y.Z tag, else main's newest
// commit), at most every 6 hours, 5 s timeout, never awaited by a request. An installed copy (~/.overvibe/app, or
// any checkout the installer left on a tag) gets an Update button that runs `overvibe update` in a terminal row; a
// clone someone runs by hand (on a branch, or with local changes) gets the git pull to run instead.

/** OVERVIBE_UPDATE_URL points the check at another GitHub-shaped API (a local mock in tests) */
export const SELF_API = (process.env.OVERVIBE_UPDATE_URL || 'https://api.github.com/repos/maribol/overvibe').replace(/\/+$/, '')
export const CHANGELOG_URL = 'https://overvibe.dev/changelog'

export type SelfLatest = { version?: string; sha?: string; source: 'release' | 'tag' | 'commit' }
export type SelfInstall = { version: string; sha?: string; mode: 'installed' | 'dev' | 'plain'; why?: string }
export type SelfUpdate = { installed: string; latest: string; source: SelfLatest['source']; mode: SelfInstall['mode']; cmd: string; why?: string; url: string }

const RELEASE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/

/** The newest Overvibe from the GitHub API at `base`: the latest release, else the highest release tag, else main's commit. */
export async function selfLatest(base: string, getJson: (url: string) => Promise<any>): Promise<SelfLatest | null> {
  try {
    const j = await getJson(`${base}/releases/latest`)
    const v = parseVersion(j?.tag_name) ?? parseVersion(j?.name)
    if (v && !j?.draft && !j?.prerelease && !v.includes('-')) return { version: v, source: 'release' }
  } catch {}
  try {
    const j = await getJson(`${base}/tags?per_page=100`)
    const vs = (Array.isArray(j) ? j : []).map((t) => (typeof t?.name === 'string' && RELEASE_TAG.test(t.name) ? parseVersion(t.name) : null)).filter((v): v is string => !!v)
    if (vs.length) return { version: vs.sort(compareVersions).at(-1)!, source: 'tag' }
  } catch {}
  try {
    const j = await getJson(`${base}/commits/main`)
    if (typeof j?.sha === 'string' && /^[0-9a-f]{7,40}$/.test(j.sha)) return { sha: j.sha, source: 'commit' }
  } catch {}
  return null
}

type Git = (args: string[]) => string | null
/** What runs here: its version (the exact tag, else package.json), its commit, and whether the installer's update may touch it. */
export function selfInstallOf(o: { appDir: string; installDir: string; git: Git; pkgVersion: string; real?: (p: string) => string }): SelfInstall {
  const real = o.real ?? realOf
  const sha = o.git(['rev-parse', 'HEAD']) ?? undefined
  const tag = o.git(['describe', '--tags', '--exact-match'])
  const version = (tag && RELEASE_TAG.test(tag) ? parseVersion(tag) : null) ?? o.pkgVersion
  if (!sha) return { version, mode: 'plain' }
  if (o.git(['status', '--porcelain', '--untracked-files=no'])) return { version, sha, mode: 'dev', why: 'local changes' }
  // the installer checks a release out detached; a branch here means someone runs this clone by hand
  const onBranch = o.git(['symbolic-ref', '-q', 'HEAD'])
  if (real(o.appDir) !== real(o.installDir) && onBranch) return { version, sha, mode: 'dev', why: 'a clone on a branch' }
  return { version, sha, mode: 'installed' }
}

/** The notice for what is installed against the newest one, or null when it is current. */
export function selfUpdateOf(inst: SelfInstall, latest: SelfLatest | null | undefined, o: { appDir: string; git?: Git }): SelfUpdate | null {
  if (!latest) return null
  let label: string
  if (latest.version) {
    if (!isNewer(inst.version, latest.version)) return null
    label = latest.version
  } else return null // a commit on main is not a release: only versions (a release or a vX.Y.Z tag) get a notice
  const cmd = inst.mode === 'installed' ? 'overvibe update' : inst.mode === 'dev' ? `git -C ${tildify(o.appDir)} pull` : 'curl -fsSL https://overvibe.dev/install.sh | sh'
  return { installed: inst.version, latest: label, source: latest.source, mode: inst.mode, cmd, why: inst.why, url: latest.version ? `${CHANGELOG_URL}#v${latest.version}` : CHANGELOG_URL }
}

const APP_DIR = join(import.meta.dir, '..')
const gitIn = (dir: string): Git => (args) => {
  try {
    const r = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    return r.exitCode === 0 ? r.stdout.toString().trim() : null
  } catch {
    return null
  }
}
let installSeen: { at: number; v: SelfInstall } | null = null
/** What is installed, read from git at most once a minute (the page asks every few seconds). */
function selfInstall(): SelfInstall {
  if (installSeen && Date.now() - installSeen.at < 60_000) return installSeen.v
  const v = selfInstallOf({ appDir: APP_DIR, installDir: join(HOME, '.overvibe', 'app'), git: gitIn(APP_DIR), pkgVersion: APP_VERSION })
  installSeen = { at: Date.now(), v }
  return v
}

/** A newer Overvibe for the sidebar, from the cached check (refreshed in the background when stale). Never waits on the network. */
export function selfUpdate(): SelfUpdate | null {
  const e = cache.overvibe
  const fresh = e && e.src === SELF_API && Date.now() - e.at <= (e.ok ? EVERY : RETRY)
  if (!fresh && !running.has('overvibe')) {
    running.add('overvibe')
    void (async () => {
      try {
        const v = await selfLatest(SELF_API, (u) => get(u, false))
        cache.overvibe = v ? { self: v, src: SELF_API, at: Date.now(), ok: true } : { src: SELF_API, at: Date.now(), ok: false }
      } finally {
        running.delete('overvibe')
        try {
          writeFileSync(FILE, JSON.stringify(cache))
        } catch {}
      }
    })()
  }
  if (e?.src !== SELF_API) return null
  const inst = selfInstall()
  const key = `${e.at}:${inst.version}:${inst.sha}:${inst.mode}`
  if (selfSeen?.key !== key) selfSeen = { key, v: selfUpdateOf(inst, e.self, { appDir: APP_DIR, git: gitIn(APP_DIR) }) }
  return selfSeen.v
}
let selfSeen: { key: string; v: SelfUpdate | null } | null = null

/** After Update ran: read git and the latest release again on the next look. */
export function forgetSelfUpdate() {
  delete cache.overvibe
  installSeen = null
  selfSeen = null
}

/** The command the Update button runs: the CLI from this app folder, with the bun that runs this server. */
export const selfUpdateCommand = () => `${shq(process.execPath)} ${shq(join(APP_DIR, 'bin', 'overvibe'))} update`
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
